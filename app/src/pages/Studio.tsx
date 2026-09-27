import { useMemo, useState } from 'react';
import {
  MECHANIC_LABELS,
  quoteBuy, quoteSell, stressTest, validateCurveConfig, linearFromPerToken,
  type CurveConfig, type CurveState,
  canTransfer, canRedeem, decaySchedule, recipientOfRemovedValue,
  type DecayConfig,
  createDynamicState, appendUpdate, evaluateStaleness, isStale,
  type DynamicConfig,
  createVesselState, deposit, withdraw, transferOwnership,
  type VesselConfig,
  createProofXState, mintFromAttestation, revokeAttestation, verificationModeDescription,
  type ProofXConfig, type Attestation,
  estimateExperimentCost,
  recommendExtensions, checkCompatibility,
  type CompatFinding,
  simulateDeposit, simulateRedeem, withdrawalLimitAmount, collateralRatioBps,
  validateVaultConfig, U64_MAX,
  type VaultState,
  type MechanicKind, type HolderRight, type CompatibilityWarning, type ExperimentConfig,
} from '@sdk';
import { HonestyBanner } from '../components/HonestyBanner';
import { DeployPanel, type CurveInitParams } from '../studio/DeployPanel';

const MECHANICS: { kind: MechanicKind; icon: string; blurb: string }[] = [
  { kind: 'curve', icon: '📈', blurb: 'Price set by an audited curve template (linear or step). Buy/sell against a reserve vault with fees and slippage.' },
  { kind: 'decay', icon: '⏳', blurb: 'Fixed expiration plus a separately specified periodic decay. See exactly who receives removed value.' },
  { kind: 'dynamic', icon: '🔮', blurb: 'Supply/metadata follows authenticated oracle data. Stale-data behavior is disclosed, never hidden.' },
  { kind: 'vessel', icon: '🏺', blurb: 'A transferable container over a defined asset set. Ownership transfer moves the whole basket.' },
  { kind: 'proofx', icon: '🎖️', blurb: 'Mint from a verifiable attestation with replay prevention and revocation. Manual approval is never called automatic.' },
  { kind: 'vault', icon: '🏦', blurb: 'Segregated collateral vault: share accounting, withdrawal limits, proof accounts. Devnet collateral is MOCK-GOLD only — never PAXG.' },
];

const bi = (s: string): bigint | null => {
  try {
    const v = BigInt(s.trim());
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Config shapes (all fields strings for form editing; parsed when simulating)
// ---------------------------------------------------------------------------
interface CurveForm { template: 'linear' | 'step'; basePrice: string; slope: string; feeBps: string; steps: string; }
interface DecayForm { expiresAt: string; periodDays: string; rateBps: string; recipient: string; transfersAfter: boolean; redeemAfter: boolean; }
interface DynamicForm { oracleId: string; updateAuthority: string; maxSupply: string; maxAgeSec: string; minIntervalSec: string; staleBehavior: 'freeze-transfers' | 'use-last-value' | 'reject-new-updates'; scale: string; }
interface VesselForm { custodyProgram: string; depositAuthority: string; withdrawAuthority: string; }
interface ProofXForm { verifier: string; evidenceFormat: string; automatic: boolean; disputeProcess: string; privacyTreatment: string; }
interface VaultForm { withdrawalLimitBps: string; redeemFeeBps: string; mockLabel: string; }

const DEFAULTS = {
  curve: { template: 'linear', basePrice: '1000', slope: '2', feeBps: '30', steps: '1000000:10, 5000000:25, 20000000:60' } as CurveForm,
  decay: { expiresAt: '2027-09-27', periodDays: '30', rateBps: '500', recipient: 'creator-treasury', transfersAfter: false, redeemAfter: true } as DecayForm,
  dynamic: { oracleId: 'pyth:SOL/USD', updateAuthority: '', maxSupply: '1000000', maxAgeSec: '300', minIntervalSec: '60', staleBehavior: 'freeze-transfers', scale: '10' } as DynamicForm,
  vessel: { custodyProgram: 'vessel-custody-program', depositAuthority: 'demo-owner', withdrawAuthority: 'demo-owner' } as VesselForm,
  proofx: { verifier: '', evidenceFormat: 'sha256-of-signed-completion-certificate', automatic: false, disputeProcess: 'Email disputes with your evidence hash; reviewed within 14 days.', privacyTreatment: 'Only the evidence hash is stored on-chain; raw evidence stays off-chain.' } as ProofXForm,
  vault: { withdrawalLimitBps: '1000', redeemFeeBps: '30', mockLabel: 'MOCK-GOLD — NOT PAXG, NO VALUE' } as VaultForm,
};

interface AuthorityForm { mintAuthority: string; permanentDelegate: boolean; transferHook: boolean; extensions: string[]; }
const AUTH_DEFAULT: AuthorityForm = { mintAuthority: '', permanentDelegate: false, transferHook: false, extensions: [] };
const EXTENSION_OPTIONS = ['transfer-hook', 'permanent-delegate', 'non-transferable', 'metadata-pointer', 'default-account-state'];

// ---------------------------------------------------------------------------
// Builders: form -> SDK config
// ---------------------------------------------------------------------------
function buildCurveConfig(f: CurveForm): CurveConfig {
  if (f.template === 'linear') {
    // Form slope is per-token; the SDK scales it to on-chain fixed-point.
    return linearFromPerToken(bi(f.basePrice) ?? 0n, bi(f.slope) ?? 0n, parseInt(f.feeBps, 10) || 0);
  }
  const steps = f.steps.split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const [bound, price] = pair.split(':').map((x) => x.trim());
    return { supplyUpperBound: bi(bound) ?? 0n, price: bi(price) ?? 0n };
  }).sort((a, b) => (a.supplyUpperBound < b.supplyUpperBound ? -1 : 1));
  return { kind: 'step', steps, feeBps: parseInt(f.feeBps, 10) || 0 };
}

function buildDecayConfig(f: DecayForm): DecayConfig {
  return {
    expiresAt: Math.floor(new Date(f.expiresAt + 'T00:00:00Z').getTime() / 1000) || 0,
    decayPeriodSeconds: (parseInt(f.periodDays, 10) || 30) * 86400,
    decayRateBps: parseInt(f.rateBps, 10) || 0,
    removedValueRecipient: f.recipient || 'creator-treasury',
    transfersAllowedAfterExpiry: f.transfersAfter,
    redemptionAllowedAfterExpiry: f.redeemAfter,
  };
}

function buildDynamicConfig(f: DynamicForm): DynamicConfig {
  return {
    oracleId: f.oracleId,
    updateAuthority: f.updateAuthority || null,
    maxSupply: bi(f.maxSupply) ?? 0n,
    maxUpdateAgeSeconds: parseInt(f.maxAgeSec, 10) || 300,
    minUpdateIntervalSeconds: parseInt(f.minIntervalSec, 10) || 60,
    staleBehavior: f.staleBehavior,
    valueToSupplyScale: bi(f.scale) ?? 1n,
  };
}

function buildVesselConfig(f: VesselForm): VesselConfig {
  return {
    custodyProgram: f.custodyProgram,
    // Blank fields fall back to the demo owner key (simulation default, disclosed in the form hint).
    depositAuthority: f.depositAuthority.trim() || 'demo-owner',
    withdrawAuthority: f.withdrawAuthority.trim() || 'demo-owner',
  };
}

function buildProofXConfig(f: ProofXForm): ProofXConfig {
  return {
    trustedVerifiers: f.verifier ? [f.verifier] : [],
    evidenceFormat: f.evidenceFormat,
    replayPrevention: 'nonce-set',
    revocationAuthority: f.verifier || null,
    disputeProcess: f.disputeProcess,
    privacyTreatment: f.privacyTreatment,
    automatic: f.automatic,
  };
}

/**
 * Derive the "I understand that ..." acknowledgment statement shown next to a
 * red finding's checkbox. The statement is derived from the SDK finding's own
 * title so it stays in sync with the research-backed checker.
 */
function ackStatement(f: CompatFinding): string {
  const t = f.title.replace(/^(Hard warning|Escalated hard warning|Protocol-invalid|Protocol-suspect):\s*/i, '');
  const lowered = t.charAt(0).toLowerCase() + t.slice(1);
  return `I understand that ${lowered} — I accept this consequence for this devnet experiment.`;
}

function buildExperiment(name: string, symbol: string, decimals: string, mechanic: MechanicKind, auth: AuthorityForm): ExperimentConfig {
  const extensions = [...auth.extensions];
  if (auth.transferHook && !extensions.includes('transfer-hook')) extensions.push('transfer-hook');
  if (auth.permanentDelegate && !extensions.includes('permanent-delegate')) extensions.push('permanent-delegate');
  return {
    name: name || 'Untitled Experiment',
    symbol: symbol || 'EXP',
    decimals: Math.min(9, Math.max(0, parseInt(decimals, 10) || 6)),
    mechanic,
    authorities: {
      mintAuthority: auth.mintAuthority || null,
      freezeAuthority: null,
      updateAuthority: null,
      permanentDelegate: auth.permanentDelegate ? 'PERMANENT-DELEGATE-ENABLED' : null,
      transferHookProgram: auth.transferHook ? 'TRANSFER-HOOK-PROGRAM' : null,
    },
    extensions,
  };
}

// ---------------------------------------------------------------------------
// Compatibility warnings + holder rights
// ---------------------------------------------------------------------------
function compatibilityWarnings(exp: ExperimentConfig, mechanic: MechanicKind): CompatibilityWarning[] {
  const w: CompatibilityWarning[] = [];
  if (exp.authorities.permanentDelegate) {
    w.push({ severity: 'blocking', code: 'PERMANENT_DELEGATE', message: 'Permanent delegate is ENABLED: this authority can transfer or burn any holder\u2019s tokens without consent. Requires separate explicit confirmation.' });
  }
  if (exp.authorities.transferHookProgram || exp.extensions.includes('transfer-hook')) {
    w.push({ severity: 'warning', code: 'TRANSFER_HOOK', message: 'Transfer hook requires a hook program: expect wallet and DEX integration friction. Some wallets/DEXs may not support transfers.' });
  }
  if (exp.extensions.includes('non-transferable')) {
    w.push({ severity: 'info', code: 'NON_TRANSFERABLE', message: 'Non-transferable: tokens cannot be sent or traded on secondary markets by design.' });
  }
  if (exp.extensions.length === 0) {
    w.push({ severity: 'info', code: 'NO_EXTENSIONS', message: 'No Token-2022 extensions: maximum wallet and DEX compatibility.' });
  }
  if (mechanic === 'curve') {
    w.push({ severity: 'info', code: 'CURVE_ROUNDING', message: 'Buy quotes are floored (dust favors buyer); fees round up. The on-chain program must implement identical rounding.' });
  }
  if (mechanic === 'dynamic') {
    w.push({ severity: 'warning', code: 'ORACLE_TRUST', message: 'Off-chain oracle data is not decentralized merely because its result is written on-chain. Holders trust the feed and the update authority.' });
  }
  if (mechanic === 'vault') {
    w.push({ severity: 'warning', code: 'VAULT_UNVERIFIED', message: 'The vault program is UNVERIFIED: not deployed to devnet and no end-to-end devnet transaction has succeeded. Devnet collateral must be MOCK-GOLD (metadata-only extensions); the program rejects the real PAXG mint\u2019s extension shape (permanent delegate) in stage 3.' });
  }
  return w;
}

function holderRights(mechanic: MechanicKind, forms: typeof DEFAULTS): HolderRight[] {
  switch (mechanic) {
    case 'curve': {
      const f = forms.curve;
      return [
        { title: 'Price discovery', description: `The token price is set by a ${f.template} bonding curve, not by the creator\u2019s discretion. Every trade moves the price along the curve.` },
        { title: 'Right to sell', description: 'You can sell back to the reserve vault at the current curve price at any time — the vault, not a counterparty, is your buyer.' },
        { title: 'Fees', description: `A ${f.feeBps} bps protocol fee applies to each trade (rounded up). Slippage depends on trade size; check the quote before confirming.` },
      ];
    }
    case 'decay': {
      const f = forms.decay;
      return [
        { title: 'Balances shrink by design', description: `Every ${f.periodDays} days, ${Number(f.rateBps) / 100}% of each balance is removed. This is the token\u2019s stated behavior, not a malfunction.` },
        { title: 'Removed value goes to the treasury', description: recipientOfRemovedValue(buildDecayConfig(f)) },
        { title: 'Expiry', description: `After ${f.expiresAt}, transfers are ${f.transfersAfter ? 'still allowed' : 'disabled'} and redemption is ${f.redeemAfter ? 'still available' : 'disabled'}.` },
      ];
    }
    case 'dynamic': {
      const f = forms.dynamic;
      return [
        { title: 'Supply follows data', description: `Supply tracks the \u201c${f.oracleId}\u201d feed (value \u00d7 ${f.scale}), capped at ${f.maxSupply} tokens. The feed is an off-chain source.` },
        { title: 'Stale-data protection', description: { 'freeze-transfers': 'If the feed goes stale, transfers freeze until fresh data arrives.', 'use-last-value': 'If the feed goes stale, the last value keeps applying.', 'reject-new-updates': 'If the feed goes stale, new updates are rejected until it recovers.' }[f.staleBehavior] },
        { title: 'Full history', description: 'Every oracle update is recorded in an append-only history you can audit.' },
      ];
    }
    case 'vessel': {
      const f = forms.vessel;
      return [
        { title: 'You own a container', description: 'The token represents a claim on the vessel\u2019s holdings ledger, custodied by the vessel program.' },
        { title: 'Transfers move the whole basket', description: 'Sending the token transfers every holding and the permission rules to the new owner. The previous owner keeps nothing.' },
        { title: 'Permissions', description: `Deposits: only ${f.depositAuthority.trim() || 'demo-owner'} (deposit authority). Withdrawals: only ${f.withdrawAuthority.trim() || 'demo-owner'} (withdraw authority). Neither role rotates on ownership transfer.` },
      ];
    }
    case 'proofx': {
      const f = forms.proofx;
      return [
        { title: 'Mint requires proof', description: `Tokens mint only from an attestation signed by a trusted verifier, using evidence format \u201c${f.evidenceFormat}\u201d.` },
        { title: 'Replay protection', description: 'Each attestation carries a one-time nonce. Replaying it is rejected — one attestation, one mint.' },
        { title: f.automatic ? 'Automatic verification' : 'Manual approval', description: verificationModeDescription(buildProofXConfig(f)) },
        { title: 'Revocation', description: 'The revocation authority can revoke attestations; revoked attestations can never mint.' },
      ];
    }
    case 'vault': {
      const f = forms.vault;
      return [
        { title: 'Pro-rata claims, not a promised price', description: `Shares represent a pro-rata claim on the vault's collateral; the redeemable value tracks the vault's actual holdings, never a guaranteed gold price or floor.` },
        { title: 'Fees and limits', description: `Redemptions pay a ${f.redeemFeeBps} bps fee (rounded up) and each redemption is capped at ${f.withdrawalLimitBps} bps of the vault — the limit protects solvency for remaining holders.` },
        { title: 'Proof you can recompute', description: 'The vault publishes a read-only proof account (balance, liabilities, ratio, authorities). Anyone can recompute the ratio from public chain state; the proof is a snapshot, not a guarantee of future value.' },
        { title: 'Mock collateral only (devnet)', description: `Devnet collateral is ${f.mockLabel} — no gold backing, no redemption value, never labeled PAXG. Real PAXG integration is gated separately (see docs/STAGES.md).` },
      ];
    }
    default: {
      throw new Error(`Unknown mechanic: ${mechanic satisfies never}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const STEPS = ['Mechanic', 'Configure', 'Simulate & costs', 'Review & deploy'];

export function Studio() {
  const [mechanic, setMechanic] = useState<MechanicKind | null>(null);
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState<'simple' | 'advanced'>('simple');
  const [name, setName] = useState('My Experiment');
  const [symbol, setSymbol] = useState('EXP');
  const [decimals, setDecimals] = useState('6');
  const [forms, setForms] = useState(DEFAULTS);
  const [auth, setAuth] = useState<AuthorityForm>(AUTH_DEFAULT);
  const [advJson, setAdvJson] = useState('');
  const [advError, setAdvError] = useState('');
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployNote, setDeployNote] = useState('');
  const [mainnetPhrase, setMainnetPhrase] = useState('');
  const MAINNET_PHRASE = 'I UNDERSTAND MAINNET IS IRREVERSIBLE';
  /** Subjects of red compatibility findings the creator has explicitly acknowledged. */
  const [ackedFindings, setAckedFindings] = useState<string[]>([]);

  const setForm = <K extends MechanicKind>(k: K, patch: Partial<(typeof DEFAULTS)[K]>) =>
    setForms((f) => ({ ...f, [k]: { ...f[k], ...patch } }));

  const openAdvanced = () => {
    if (mechanic) {
      setAdvJson(JSON.stringify(forms[mechanic], null, 2));
      setAdvError('');
    }
    setTab('advanced');
  };

  const applyAdvanced = () => {
    if (!mechanic) return;
    try {
      const parsed = JSON.parse(advJson);
      setForms((f) => ({ ...f, [mechanic]: { ...DEFAULTS[mechanic], ...parsed } }));
      setAdvError('');
      setTab('simple');
    } catch (e) {
      setAdvError(`Invalid JSON: ${(e as Error).message}`);
    }
  };

  const experiment = useMemo(
    () => (mechanic ? buildExperiment(name, symbol, decimals, mechanic, auth) : null),
    [name, symbol, decimals, mechanic, auth],
  );
  const warnings = useMemo(
    () => (experiment && mechanic ? compatibilityWarnings(experiment, mechanic) : []),
    [experiment, mechanic],
  );
  const rights = useMemo(() => (mechanic ? holderRights(mechanic, forms) : []), [mechanic, forms]);
  const cost = useMemo(() => (experiment ? estimateExperimentCost(experiment) : null), [experiment]);

  // Recommended extension set for this mechanic (SDK, deterministic) and its
  // compatibility report. The review screen renders this report and blocks the
  // devnet deploy stub until every red finding is explicitly acknowledged.
  const recExtensions = useMemo(() => (mechanic ? recommendExtensions(mechanic) : null), [mechanic]);
  const compatReport = useMemo(
    () => (recExtensions ? checkCompatibility(recExtensions.recommended) : null),
    [recExtensions],
  );
  const redFindings = useMemo(
    () => (compatReport?.findings ?? []).filter((f) => f.requiresAcknowledgment),
    [compatReport],
  );
  const allRedAcked = redFindings.every((f) => ackedFindings.includes(f.subject));
  const deployBlocked = (compatReport?.blocked ?? false) && !allRedAcked;

  // Params for the live devnet curve pilot (step 4 of DeployPanel). Only built
  // when the curve config validates — otherwise the pilot stays gated.
  const curveInit = useMemo<CurveInitParams | null>(() => {
    if (mechanic !== 'curve' || !experiment) return null;
    const cfg = buildCurveConfig(forms.curve);
    if (validateCurveConfig(cfg).length > 0) return null;
    const decimals = experiment.decimals;
    if (cfg.kind === 'linear') {
      return { kind: 'linear', decimals, slope: cfg.slope, intercept: cfg.basePrice, steps: [], feeBps: cfg.feeBps };
    }
    return {
      kind: 'step',
      decimals,
      slope: 0n,
      intercept: 0n,
      steps: cfg.steps.map((s) => ({ supply: s.supplyUpperBound, price: s.price })),
      feeBps: cfg.feeBps,
    };
  }, [mechanic, forms.curve, experiment]);

  const pick = (k: MechanicKind) => {
    setMechanic(k);
    setAckedFindings([]);
    setStep(1);
    setTab('simple');
  };

  return (
    <div className="page">
      <h1>Creator studio</h1>
      <p className="lede">Design a token mechanic, simulate its economics, see the costs and compatibility warnings, and review holder rights before anything touches devnet. Mainnet always requires explicit confirmation.</p>
      <HonestyBanner mode="simulation" />

      <div className="steps">
        {STEPS.map((s, i) => (
          <span key={s} className={`step${i === step ? ' active' : ''}${i < step ? ' done' : ''}`}>{i + 1}. {s}</span>
        ))}
      </div>

      {step === 0 && (
        <div className="grid cols-5">
          {MECHANICS.map((m) => (
            <div key={m.kind} className={`card mechanic-card${mechanic === m.kind ? ' selected' : ''}`} onClick={() => pick(m.kind)}>
              <div className="icon">{m.icon}</div>
              <h3>{MECHANIC_LABELS[m.kind]}</h3>
              <p>{m.blurb}</p>
            </div>
          ))}
        </div>
      )}

      {step === 1 && mechanic && (
        <div className="grid cols-2">
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Configure — {MECHANIC_LABELS[mechanic]}</h3>
              <div className="tabs" style={{ margin: 0 }}>
                <button className={`tab${tab === 'simple' ? ' active' : ''}`} onClick={() => setTab('simple')}>Simple</button>
                <button className={`tab${tab === 'advanced' ? ' active' : ''}`} onClick={openAdvanced}>Advanced</button>
              </div>
            </div>

            <div className="field"><label>Token name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label>Symbol</label><input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></div>
              <div className="field" style={{ flex: 1 }}><label>Decimals (0–9)</label><input value={decimals} onChange={(e) => setDecimals(e.target.value)} inputMode="numeric" /></div>
            </div>

            {tab === 'simple' && <SimpleForm mechanic={mechanic} forms={forms} setForm={setForm} />}

            {tab === 'advanced' && (
              <div>
                <div className="field">
                  <label>Raw mechanic config (JSON)</label>
                  <textarea className="mono" rows={14} value={advJson} onChange={(e) => setAdvJson(e.target.value)} spellCheck={false} />
                  <span className="hint">Advanced developers: exact rules, editable directly. Applies to the simulation immediately.</span>
                </div>
                {advError && <div className="warn blocking"><span className="sev">Error</span><br />{advError}</div>}
                <button className="btn primary" onClick={applyAdvanced}>Apply JSON</button>
              </div>
            )}

            <h4 className="section-title">Authorities &amp; Token-2022 extensions</h4>
            <div className="field"><label>Mint authority (base58 pubkey, empty = none)</label><input className="mono" value={auth.mintAuthority} onChange={(e) => setAuth({ ...auth, mintAuthority: e.target.value })} placeholder="optional" /></div>
            <div className="field">
              <label>Extensions (declared BEFORE mint creation)</label>
              <div className="row">
                {EXTENSION_OPTIONS.map((ext) => (
                  <label key={ext} className="small" style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                    <input type="checkbox" checked={auth.extensions.includes(ext)} onChange={(e) => setAuth({ ...auth, extensions: e.target.checked ? [...auth.extensions, ext] : auth.extensions.filter((x) => x !== ext) })} />
                    <span className="mono">{ext}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="small" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.6rem' }}>
              <input type="checkbox" checked={auth.permanentDelegate} onChange={(e) => setAuth({ ...auth, permanentDelegate: e.target.checked })} />
              Enable permanent delegate <span className="badge unverified">powerful</span>
            </label>
            <label className="small" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" checked={auth.transferHook} onChange={(e) => setAuth({ ...auth, transferHook: e.target.checked })} />
              Enable transfer hook program
            </label>
            {auth.permanentDelegate && <div className="warn blocking"><span className="sev">Blocking</span><br />A permanent delegate can transfer or burn <em>any</em> holder's tokens without consent. This needs a separate explicit confirmation at deploy.</div>}
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Holder rights — plain English</h3>
            <ul className="rights">
              {rights.map((r) => <li key={r.title}><strong>{r.title}.</strong> {r.description}</li>)}
            </ul>
            <div className="row mt">
              <button className="btn ghost" onClick={() => { setStep(0); }}>← Change mechanic</button>
              <button className="btn primary" onClick={() => setStep(2)}>Simulate →</button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && mechanic && (
        <div>
          <SimPanel mechanic={mechanic} forms={forms} />
          <DeployPanel simulated mechanic={mechanic} experiment={experiment} curveInit={curveInit} />
          <div className="grid cols-2 mt">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Estimated creation cost <span className="badge devnet">devnet</span></h3>
              {cost && (
                <>
                  <table className="data">
                    <thead><tr><th>Item</th><th className="num">Lamports</th></tr></thead>
                    <tbody>
                      {cost.items.map((i) => <tr key={i.label}><td>{i.label}<div className="muted small">{i.detail}</div></td><td className="num mono">{i.lamports.toString()}</td></tr>)}
                    </tbody>
                  </table>
                  <p><strong>Total: {cost.totalSol} SOL</strong> <span className="muted small">({cost.totalLamports.toString()} lamports)</span></p>
                  <p className="muted small">{cost.note}</p>
                </>
              )}
            </div>
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Compatibility warnings</h3>
              {warnings.map((w) => (
                <div key={w.code} className={`warn${w.severity === 'blocking' ? ' blocking' : ''}${w.severity === 'info' ? ' info' : ''}`}>
                  <span className="sev">{w.severity}</span><br />{w.message}
                </div>
              ))}
              <h3 className="section-title">Holder rights — plain English</h3>
              <ul className="rights">
                {rights.map((r) => <li key={r.title}><strong>{r.title}.</strong> {r.description}</li>)}
              </ul>
            </div>
          </div>
          <div className="row mt">
            <button className="btn ghost" onClick={() => setStep(1)}>← Back to config</button>
            <button className="btn primary" onClick={() => setStep(3)}>Review →</button>
          </div>
        </div>
      )}

      {step === 3 && mechanic && experiment && cost && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Review before deployment <span className="badge sim">simulation</span></h3>
          <dl className="kv">
            <dt>Name / Symbol</dt><dd>{experiment.name} ({experiment.symbol}), {experiment.decimals} decimals</dd>
            <dt>Mechanic</dt><dd>{MECHANIC_LABELS[mechanic]}</dd>
            <dt>Extensions</dt><dd className="mono">{recExtensions ? (recExtensions.recommended.join(', ') || 'none') : 'none'}</dd>
            <dt>Authorities</dt><dd className="mono small">
              mint: {experiment.authorities.mintAuthority ?? 'none'} · permanent delegate: {experiment.authorities.permanentDelegate ? 'ENABLED' : 'none'} · transfer hook: {experiment.authorities.transferHookProgram ? 'ENABLED' : 'none'}
            </dd>
            <dt>Est. cost</dt><dd>{cost.totalSol} SOL (devnet estimate)</dd>
          </dl>
          <p className="muted small">Extensions are declared <strong>BEFORE mint creation</strong> — the set above is what will be enabled, shown here first. The compatibility check below evaluates exactly this set (deterministic SDK check, no chain).</p>

          {compatReport && recExtensions && (
            <div>
              <h4 className="section-title">
                Token-2022 compatibility check{' '}
                <span className={`badge compat-${compatReport.overall}`}>{compatReport.overall}</span>{' '}
                <span className="badge sim">simulation</span>
              </h4>
              <p className="small">Recommended extensions for {MECHANIC_LABELS[mechanic]}: <span className="mono">{recExtensions.recommended.join(', ') || 'none'}</span></p>
              <p className="small muted">{recExtensions.notes}</p>
              {!compatReport.protocolValid && (
                <div className="warn blocking"><span className="sev">Protocol-invalid</span><br />This extension set is rejected by the Token-2022 program at mint initialization. The mint cannot be created as configured — the findings below describe how to fix it.</div>
              )}
              {compatReport.findings.map((f) => (
                <div key={f.subject} className={`warn${f.severity === 'red' ? ' blocking' : ''}${f.severity === 'green' ? ' info' : ''}`}>
                  <span className="sev">{f.severity === 'red' ? 'Blocking — acknowledgment required' : f.severity === 'amber' ? 'Warning' : 'OK'}</span><br />
                  <strong>{f.title}</strong><br />
                  {f.explanation}
                  {f.venueNotes.length > 0 && (
                    <ul className="small" style={{ marginBottom: 0 }}>
                      {f.venueNotes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                  {f.requiresAcknowledgment && (
                    <label className="small" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem', alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        style={{ marginTop: '0.25rem' }}
                        checked={ackedFindings.includes(f.subject)}
                        onChange={(e) => setAckedFindings((a) => e.target.checked ? [...a, f.subject] : a.filter((s) => s !== f.subject))}
                      />
                      <span>{ackStatement(f)}</span>
                    </label>
                  )}
                </div>
              ))}
              {compatReport.blocked && (
                <p className="small" style={{ color: 'var(--danger)' }}>
                  {allRedAcked
                    ? 'All red findings acknowledged — the devnet deploy stub is unlocked.'
                    : 'Deploy to devnet is BLOCKED until every red finding above is explicitly acknowledged.'}
                </p>
              )}
            </div>
          )}

          <h4 className="section-title">Warnings acknowledged</h4>
          {warnings.filter((w) => w.severity !== 'info').map((w) => (
            <div key={w.code} className={`warn${w.severity === 'blocking' ? ' blocking' : ''}`}><span className="sev">{w.severity}</span><br />{w.message}</div>
          ))}
          {warnings.filter((w) => w.severity !== 'info').length === 0 && <p className="muted small">No warnings or blockers.</p>}

          {mechanic === 'vault' && (
            <div className="warn blocking">
              <span className="sev">Vault review notes</span><br />
              Collateral mint must be <strong>MOCK-GOLD</strong> on devnet — a metadata-only Token-2022 mint labeled
              unmistakably (e.g. "MOCK-GOLD — NOT PAXG, NO VALUE"). It must never appear on mainnet, and no devnet
              token may be labeled PAXG. The on-chain program allow-lists metadata-only collateral mints and rejects
              the real PAXG mint's extension shape (permanent delegate) in stage 3. Real PAXG integration stays
              gated on direct Paxos confirmation plus a threat model covering the mint's permanent delegate,
              freeze/upgrade authorities, and the 430-PAXG physical-redemption minimum.
            </div>
          )}

          <div className="row mt">
            <button className="btn ghost" onClick={() => setStep(2)}>← Back</button>
            <button className="btn primary" disabled={deployBlocked} onClick={() => { setDeployNote(''); setDeployOpen(true); }}>Deploy to devnet</button>
          </div>
          {deployBlocked && <p className="small" style={{ color: 'var(--danger)' }}>The deploy stub stays disabled until every red compatibility finding above is acknowledged.</p>}
          <div className="card mt" style={{ borderColor: '#7c2a35' }}>
            <h4 style={{ marginTop: 0, color: 'var(--danger)' }}>Mainnet launch — hard-gated</h4>
            <p className="small muted">Mainnet deployment is a separate, irreversible action. Type the exact phrase to unlock the button. Even unlocked, this build does not execute a mainnet deployment.</p>
            <div className="field">
              <label>Type: <span className="mono">{MAINNET_PHRASE}</span></label>
              <input className="mono" value={mainnetPhrase} onChange={(e) => setMainnetPhrase(e.target.value)} placeholder="type the phrase exactly" />
            </div>
            <button className="btn danger" disabled={mainnetPhrase !== MAINNET_PHRASE} onClick={() => setDeployNote('Mainnet deployment is disabled in this build. The typed confirmation was recorded, but no transaction was — or will be — sent without a full security review and a separate explicit approval.')}>Deploy to mainnet</button>
            {deployNote && <p className="small mt">{deployNote}</p>}
          </div>
        </div>
      )}

      {deployOpen && (
        <div className="modal-backdrop" onClick={() => setDeployOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Deploy to devnet <span className="badge sim">stub</span></h2>
            <p>Devnet deployment is <strong>not wired up</strong> in this build — confirming sends <strong>no transaction</strong> and creates nothing on-chain.</p>
            <p className="small muted">When wired, this step will: create the Token-2022 mint with the declared extensions, deploy the mechanic program accounts, and register the experiment. Estimated cost: {cost?.totalSol ?? '?'} SOL on devnet (faucet-funded).</p>
            <div className="actions">
              <button className="btn ghost" onClick={() => setDeployOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={() => { setDeployOpen(false); setDeployNote('Devnet deploy confirmed (stub): no transaction was sent. Program deployment wiring is tracked as incomplete in docs/STAGES.md.'); setStep(3); }}>Confirm (stub — sends nothing)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Simple config forms per mechanic
// ---------------------------------------------------------------------------
function SimpleForm({ mechanic, forms, setForm }: {
  mechanic: MechanicKind;
  forms: typeof DEFAULTS;
  setForm: <K extends MechanicKind>(k: K, patch: Partial<(typeof DEFAULTS)[K]>) => void;
}) {
  switch (mechanic) {
    case 'curve': {
      const f = forms.curve;
      return (
        <>
          <div className="field">
            <label>Curve template</label>
            <select value={f.template} onChange={(e) => setForm('curve', { template: e.target.value as 'linear' | 'step' })}>
              <option value="linear">Linear (audited template)</option>
              <option value="step">Step (audited template)</option>
            </select>
            <span className="hint">v1 accepts only these audited templates — no arbitrary user formulas.</span>
          </div>
          {f.template === 'linear' ? (
            <div className="row">
              <div className="field" style={{ flex: 1 }}><label>Base price (quote units / token)</label><input value={f.basePrice} onChange={(e) => setForm('curve', { basePrice: e.target.value })} inputMode="numeric" /></div>
              <div className="field" style={{ flex: 1 }}><label>Slope (price increase / token)</label><input value={f.slope} onChange={(e) => setForm('curve', { slope: e.target.value })} inputMode="numeric" /></div>
            </div>
          ) : (
            <div className="field"><label>Steps (supplyBound:price, comma-separated)</label><input className="mono" value={f.steps} onChange={(e) => setForm('curve', { steps: e.target.value })} /><span className="hint">Example: 1000000:10 means “10 quote units per token until supply 1,000,000”.</span></div>
          )}
          <div className="field"><label>Protocol fee (basis points)</label><input value={f.feeBps} onChange={(e) => setForm('curve', { feeBps: e.target.value })} inputMode="numeric" /><span className="hint">100 bps = 1%. Rounded up in the protocol's favor.</span></div>
        </>
      );
    }
    case 'decay': {
      const f = forms.decay;
      return (
        <>
          <div className="field"><label>Expiry date</label><input type="date" value={f.expiresAt} onChange={(e) => setForm('decay', { expiresAt: e.target.value })} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Decay period (days)</label><input value={f.periodDays} onChange={(e) => setForm('decay', { periodDays: e.target.value })} inputMode="numeric" /></div>
            <div className="field" style={{ flex: 1 }}><label>Decay rate (basis points / period)</label><input value={f.rateBps} onChange={(e) => setForm('decay', { rateBps: e.target.value })} inputMode="numeric" /><span className="hint">500 bps = 5% per period.</span></div>
          </div>
          <div className="field"><label>Recipient of removed value</label><input value={f.recipient} onChange={(e) => setForm('decay', { recipient: e.target.value })} /><span className="hint">“creator-treasury” or a base58 address. Never silently burned.</span></div>
          <label className="small" style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}><input type="checkbox" checked={f.transfersAfter} onChange={(e) => setForm('decay', { transfersAfter: e.target.checked })} /> Transfers allowed after expiry</label>
          <label className="small" style={{ display: 'flex', gap: '0.5rem' }}><input type="checkbox" checked={f.redeemAfter} onChange={(e) => setForm('decay', { redeemAfter: e.target.checked })} /> Redemption allowed after expiry</label>
        </>
      );
    }
    case 'dynamic': {
      const f = forms.dynamic;
      return (
        <>
          <div className="field"><label>Oracle / data source label</label><input value={f.oracleId} onChange={(e) => setForm('dynamic', { oracleId: e.target.value })} /><span className="hint">Off-chain origin label. Writing it on-chain does not make it decentralized.</span></div>
          <div className="field"><label>Update authority (base58, empty = none)</label><input className="mono" value={f.updateAuthority} onChange={(e) => setForm('dynamic', { updateAuthority: e.target.value })} /></div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Max supply</label><input value={f.maxSupply} onChange={(e) => setForm('dynamic', { maxSupply: e.target.value })} inputMode="numeric" /></div>
            <div className="field" style={{ flex: 1 }}><label>Value → supply scale</label><input value={f.scale} onChange={(e) => setForm('dynamic', { scale: e.target.value })} inputMode="numeric" /></div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Max update age (sec)</label><input value={f.maxAgeSec} onChange={(e) => setForm('dynamic', { maxAgeSec: e.target.value })} inputMode="numeric" /></div>
            <div className="field" style={{ flex: 1 }}><label>Min interval (sec)</label><input value={f.minIntervalSec} onChange={(e) => setForm('dynamic', { minIntervalSec: e.target.value })} inputMode="numeric" /></div>
          </div>
          <div className="field"><label>Stale-data behavior</label>
            <select value={f.staleBehavior} onChange={(e) => setForm('dynamic', { staleBehavior: e.target.value as DynamicForm['staleBehavior'] })}>
              <option value="freeze-transfers">Freeze transfers until fresh data</option>
              <option value="use-last-value">Keep using last value</option>
              <option value="reject-new-updates">Reject new updates until feed recovers</option>
            </select>
          </div>
        </>
      );
    }
    case 'vessel': {
      const f = forms.vessel;
      return (
        <>
          <div className="field"><label>Custody program</label><input className="mono" value={f.custodyProgram} onChange={(e) => setForm('vessel', { custodyProgram: e.target.value })} /><span className="hint">Program that holds the underlying assets. Recorded on the container.</span></div>
          <div className="field"><label>Deposit authority (base58)</label><input className="mono" value={f.depositAuthority} onChange={(e) => setForm('vessel', { depositAuthority: e.target.value })} /><span className="hint">The only key that may deposit assets. Blank uses the demo owner key.</span></div>
          <div className="field"><label>Withdraw authority (base58)</label><input className="mono" value={f.withdrawAuthority} onChange={(e) => setForm('vessel', { withdrawAuthority: e.target.value })} /><span className="hint">The only key that may withdraw assets. Blank uses the demo owner key.</span></div>
        </>
      );
    }
    case 'proofx': {
      const f = forms.proofx;
      return (
        <>
          <div className="field"><label>Verifier (base58 pubkey)</label><input className="mono" value={f.verifier} onChange={(e) => setForm('proofx', { verifier: e.target.value })} /></div>
          <div className="field"><label>Evidence format</label><input value={f.evidenceFormat} onChange={(e) => setForm('proofx', { evidenceFormat: e.target.value })} /></div>
          <label className="small" style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.9rem' }}><input type="checkbox" checked={f.automatic} onChange={(e) => setForm('proofx', { automatic: e.target.checked })} /> Automatic on-chain verification <span className="hint">(unchecked = manual approval; never labeled automatic)</span></label>
          <div className="field"><label>Dispute process (plain English)</label><textarea rows={2} value={f.disputeProcess} onChange={(e) => setForm('proofx', { disputeProcess: e.target.value })} /></div>
          <div className="field"><label>Privacy treatment (plain English)</label><textarea rows={2} value={f.privacyTreatment} onChange={(e) => setForm('proofx', { privacyTreatment: e.target.value })} /></div>
        </>
      );
    }
    case 'vault': {
      const f = forms.vault;
      return (
        <>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Withdrawal limit (bps)</label><input value={f.withdrawalLimitBps} onChange={(e) => setForm('vault', { withdrawalLimitBps: e.target.value })} inputMode="numeric" /><span className="hint">10000 bps = effectively no limit (the cap floors at the full balance). Lower values stage exits and protect solvency.</span></div>
            <div className="field" style={{ flex: 1 }}><label>Redemption fee (bps)</label><input value={f.redeemFeeBps} onChange={(e) => setForm('vault', { redeemFeeBps: e.target.value })} inputMode="numeric" /><span className="hint">Rounded up on every redemption.</span></div>
          </div>
          <div className="field"><label>Mock collateral label</label><input className="mono" value={f.mockLabel} onChange={(e) => setForm('vault', { mockLabel: e.target.value })} /><span className="hint">Must make the mock nature unmistakable (e.g. "MOCK-GOLD — NOT PAXG, NO VALUE"). Devnet collateral must be MOCK-GOLD; the stage-3 program allow-lists metadata-only collateral mints and rejects the real PAXG mint's extension shape (permanent delegate). Never label any devnet token PAXG.</span></div>
        </>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Live simulation panels (SDK-driven)
// ---------------------------------------------------------------------------
function SimPanel({ mechanic, forms }: { mechanic: MechanicKind; forms: typeof DEFAULTS }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Live economic simulation <span className="badge sim">simulation</span></h3>
      <p className="muted small" style={{ marginTop: '-0.5rem' }}>Driven by the deterministic SDK engine. No wallet, no fees, no chain.</p>
      {mechanic === 'curve' && <CurveSim form={forms.curve} />}
      {mechanic === 'decay' && <DecaySim form={forms.decay} />}
      {mechanic === 'dynamic' && <DynamicSim form={forms.dynamic} />}
      {mechanic === 'vessel' && <VesselSim form={forms.vessel} />}
      {mechanic === 'proofx' && <ProofXSim form={forms.proofx} />}
      {mechanic === 'vault' && <VaultSim form={forms.vault} />}
    </div>
  );
}

function CurveSim({ form }: { form: CurveForm }) {
  const config: CurveConfig = useMemo(() => buildCurveConfig(form), [form]);
  const errors = validateCurveConfig(config);
  const [simState, setSimState] = useState<CurveState>({ supply: 1_000_000n, reserve: 10_000_000n });
  const [buyAmt, setBuyAmt] = useState('10000');
  const [sellAmt, setSellAmt] = useState('5000');
  const [err, setErr] = useState('');

  const doQuote = (fn: () => ReturnType<typeof quoteBuy>, apply: boolean) => {
    try {
      const q = fn();
      if (apply) setSimState(q.newState);
      setErr('');
      return q;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  };

  const buyQ = (() => { const a = bi(buyAmt); return a ? (() => { try { return quoteBuy(simState, config, a); } catch { return null; } })() : null; })();
  const sellQ = (() => { const a = bi(sellAmt); return a ? (() => { try { return quoteSell(simState, config, a); } catch { return null; } })() : null; })();
  const stress = useMemo(() => stressTest(config, simState), [config, simState]);

  return (
    <div>
      {errors.length > 0 && <div className="warn blocking"><span className="sev">Config error</span><br />{errors.join('; ')}</div>}
      {err && <div className="warn blocking"><span className="sev">Quote error</span><br />{err}</div>}
      <p className="small">State: supply <span className="mono">{simState.supply.toString()}</span> · reserve <span className="mono">{simState.reserve.toString()}</span> quote units</p>
      <div className="grid cols-2">
        <div>
          <div className="field"><label>Buy amount (token base units)</label><input value={buyAmt} onChange={(e) => setBuyAmt(e.target.value)} inputMode="numeric" /></div>
          {buyQ && (
            <table className="data"><tbody>
              <tr><td>Cost (excl. fee)</td><td className="num mono">{buyQ.gross.toString()}</td></tr>
              <tr><td>Fee (rounded up)</td><td className="num mono">{buyQ.fee.toString()}</td></tr>
              <tr><td><strong>Total you pay</strong></td><td className="num mono"><strong>{buyQ.total.toString()}</strong></td></tr>
              <tr><td>Avg price / token</td><td className="num mono">{buyQ.avgPrice.toString()}</td></tr>
              <tr><td>Price impact</td><td className="num mono">{buyQ.priceImpactBps.toString()} bps</td></tr>
            </tbody></table>
          )}
          <button className="btn mt" disabled={!buyQ} onClick={() => { const a = bi(buyAmt); if (a) doQuote(() => quoteBuy(simState, config, a), true); }}>Execute buy (simulation)</button>
        </div>
        <div>
          <div className="field"><label>Sell amount (token base units)</label><input value={sellAmt} onChange={(e) => setSellAmt(e.target.value)} inputMode="numeric" /></div>
          {sellQ && (
            <table className="data"><tbody>
              <tr><td>Gross proceeds</td><td className="num mono">{sellQ.gross.toString()}</td></tr>
              <tr><td>Fee (rounded up)</td><td className="num mono">{sellQ.fee.toString()}</td></tr>
              <tr><td><strong>Net you receive</strong></td><td className="num mono"><strong>{sellQ.total.toString()}</strong></td></tr>
              <tr><td>Price impact</td><td className="num mono">{sellQ.priceImpactBps.toString()} bps</td></tr>
            </tbody></table>
          )}
          <button className="btn mt" disabled={!sellQ} onClick={() => { const a = bi(sellAmt); if (a) doQuote(() => quoteSell(simState, config, a), true); }}>Execute sell (simulation)</button>
        </div>
      </div>
      <h4 className="section-title">Stress simulation</h4>
      {stress.scenarios.map((s) => (
        <div key={s.name} className="warn info"><span className="sev">{s.name}</span><br />{s.description}<br /><span className="small">{s.detail}</span></div>
      ))}
      {stress.warnings.map((w, i) => <div key={i} className="warn"><span className="sev">Warning</span><br />{w}</div>)}
      <button className="btn ghost mt" onClick={() => setSimState({ supply: 1_000_000n, reserve: 10_000_000n })}>Reset simulation state</button>
    </div>
  );
}

function DecaySim({ form }: { form: DecayForm }) {
  const config = useMemo(() => buildDecayConfig(form), [form]);
  const [balance, setBalance] = useState('1000');
  const now = Math.floor(Date.now() / 1000);
  const b = bi(balance) ?? 0n;
  const rows = decaySchedule(b, now, 12, config);
  const transfer = canTransfer(now, config);
  const redeem = canRedeem(now, config);
  return (
    <div>
      <div className="field" style={{ maxWidth: 320 }}><label>Starting balance</label><input value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="numeric" /></div>
      <p className="small">Removed value goes to: <strong>{config.removedValueRecipient}</strong> · {recipientOfRemovedValue(config)}</p>
      <p className="small">Now: transfers <strong>{transfer.allowed ? 'allowed' : 'BLOCKED'}</strong> ({transfer.reason}) · redemption <strong>{redeem.allowed ? 'allowed' : 'BLOCKED'}</strong> ({redeem.reason})</p>
      <table className="data">
        <thead><tr><th>Period</th><th>Date</th><th className="num">Balance</th><th className="num">Removed</th><th>Recipient</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.period}><td>{r.period}</td><td>{new Date(r.time * 1000).toISOString().slice(0, 10)}</td><td className="num mono">{r.balance.toString()}</td><td className="num mono">−{r.removedThisPeriod.toString()}</td><td className="mono small">{r.recipient}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DynamicSim({ form }: { form: DynamicForm }) {
  const config = useMemo(() => buildDynamicConfig(form), [form]);
  const [state, setState] = useState(() => createDynamicState(config));
  const [value, setValue] = useState('31000');
  const [err, setErr] = useState('');
  // Rebuild when config changes (simulation convenience).
  const [cfgKey, setCfgKey] = useState(JSON.stringify(config));
  const key = JSON.stringify(config);
  if (key !== cfgKey) { setCfgKey(key); setState(createDynamicState(config)); }

  const now = Math.floor(Date.now() / 1000);
  const stale = isStale(state, now);
  const evalS = evaluateStaleness(state, now);

  const post = () => {
    const v = bi(value);
    if (v === null) { setErr('Invalid value'); return; }
    try {
      setState((s) => appendUpdate({ ...s, config }, { value: v, timestamp: Math.floor(Date.now() / 1000), source: config.oracleId }, Math.floor(Date.now() / 1000)));
      setErr('');
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div>
      {err && <div className="warn blocking"><span className="sev">Update rejected</span><br />{err}</div>}
      <p className="small">Supply: <span className="mono">{state.supply.toString()}</span> · Max supply: <span className="mono">{config.maxSupply.toString()}</span> · Stale: <strong>{stale ? 'YES' : 'no'}</strong></p>
      <div className="warn info"><span className="sev">Stale behavior</span><br />{evalS.description}{evalS.transfersFrozen && ' Transfers are currently FROZEN.'}</div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>Oracle value</label><input value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" /></div>
        <button className="btn primary" onClick={post}>Post update (simulation)</button>
      </div>
      <h4 className="section-title">Append-only update history ({state.history.length})</h4>
      <table className="data">
        <thead><tr><th>#</th><th className="num">Value</th><th>Time</th><th>Source</th></tr></thead>
        <tbody>
          {state.history.map((u, i) => (
            <tr key={i}><td>{i + 1}</td><td className="num mono">{u.value.toString()}</td><td>{new Date(u.timestamp * 1000).toISOString()}</td><td className="mono small">{u.source}</td></tr>
          ))}
        </tbody>
      </table>
      {state.history.length === 0 && <p className="muted small">No updates yet — with no data, the feed counts as stale.</p>}
    </div>
  );
}

function VesselSim({ form }: { form: VesselForm }) {
  const config = useMemo(() => buildVesselConfig(form), [form]);
  const [state, setState] = useState(() => createVesselState(config, 'demo-owner'));
  const [caller, setCaller] = useState('demo-owner');
  const [mint, setMint] = useState('demo-mint');
  const [amount, setAmount] = useState('100');
  const [newOwner, setNewOwner] = useState('');
  const [err, setErr] = useState('');
  const [lastTransfer, setLastTransfer] = useState<string>('');
  const [cfgKey, setCfgKey] = useState(JSON.stringify(config));
  const key = JSON.stringify(config);
  if (key !== cfgKey) { setCfgKey(key); setState(createVesselState(config, 'demo-owner')); }

  const act = (fn: () => typeof state) => {
    try { setState(fn()); setErr(''); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <div>
      {err && <div className="warn blocking"><span className="sev">Rejected</span><br />{err}</div>}
      <p className="small">Owner: <span className="mono">{state.owner}</span> · Custody: <span className="mono">{config.custodyProgram}</span></p>
      <h4 className="section-title">Holdings ledger</h4>
      {state.holdings.length === 0 ? <p className="muted small">Empty.</p> : (
        <table className="data"><thead><tr><th>Mint</th><th className="num">Amount</th></tr></thead>
          <tbody>{state.holdings.map((h) => <tr key={h.mint}><td className="mono">{h.mint}</td><td className="num mono">{h.amount.toString()}</td></tr>)}</tbody>
        </table>
      )}
      <div className="grid cols-2 mt">
        <div>
          <div className="field"><label>Caller</label><input className="mono" value={caller} onChange={(e) => setCaller(e.target.value)} /></div>
          <div className="field"><label>Asset mint</label><input className="mono" value={mint} onChange={(e) => setMint(e.target.value)} /></div>
          <div className="field"><label>Amount</label><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" /></div>
          <div className="row">
            <button className="btn" onClick={() => { const a = bi(amount); if (a !== null) act(() => deposit(state, caller, mint, a)); }}>Deposit</button>
            <button className="btn" onClick={() => { const a = bi(amount); if (a !== null) act(() => withdraw(state, caller, mint, a)); }}>Withdraw</button>
          </div>
        </div>
        <div>
          <h4 style={{ marginTop: 0 }}>Ownership transfer</h4>
          <div className="field"><label>New owner</label><input className="mono" value={newOwner} onChange={(e) => setNewOwner(e.target.value)} placeholder="base58 pubkey" /></div>
          <button className="btn" disabled={!newOwner} onClick={() => act(() => {
            const r = transferOwnership(state, newOwner);
            setLastTransfer(`Transferred ${r.summary.transferredHoldings.length} holding(s) to ${newOwner}. Previous owner retains: ${r.summary.retainedByPreviousOwner.length === 0 ? 'nothing' : r.summary.retainedByPreviousOwner.join(', ')}. Custody program unchanged.`);
            return r.state;
          })}>Transfer container (simulation)</button>
          {lastTransfer && <p className="small mt">{lastTransfer}</p>}
        </div>
      </div>
    </div>
  );
}

function ProofXSim({ form }: { form: ProofXForm }) {
  const config = useMemo(() => buildProofXConfig(form), [form]);
  const [state, setState] = useState(() => {
    try { return createProofXState(config); } catch { return null; }
  });
  const [subject, setSubject] = useState('demo-holder');
  const [nonce, setNonce] = useState('nonce-demo-1');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [cfgKey, setCfgKey] = useState(JSON.stringify(config));
  const key = JSON.stringify(config);
  if (key !== cfgKey) { setCfgKey(key); try { setState(createProofXState(config)); } catch { setState(null); } }

  // Simulated stub signature check — labeled as a stub, never as real verification.
  const stubSig = () => true;

  const doMint = () => {
    if (!state) return;
    const now = Math.floor(Date.now() / 1000);
    const att: Attestation = {
      attestationId: `att-${nonce}`,
      subject,
      claimType: 'demo-claim',
      evidenceHash: 'demo-evidence-hash',
      nonce,
      issuedAt: now - 60,
      expiresAt: now + 3600,
      verifier: config.trustedVerifiers[0] ?? '',
    };
    try {
      setState(mintFromAttestation(state, att, 1n, stubSig, now));
      setOk(`Minted 1 token to ${subject} from attestation ${att.attestationId}. Nonce consumed.`);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
      setOk('');
    }
  };

  const revoke = () => {
    if (!state) return;
    try {
      setState(revokeAttestation(state, `att-${nonce}`, config.revocationAuthority ?? ''));
      setOk(`Revoked att-${nonce}.`);
      setErr('');
    } catch (e) { setErr((e as Error).message); setOk(''); }
  };

  if (!state) return <div className="warn blocking"><span className="sev">Config error</span><br />Proof-of-X needs at least one trusted verifier.</div>;

  return (
    <div>
      <p className="small">{verificationModeDescription(config)} <span className="badge sim">simulated stub</span></p>
      {err && <div className="warn blocking"><span className="sev">Rejected</span><br />{err}</div>}
      {ok && <div className="warn info"><span className="sev">OK</span><br />{ok}</div>}
      <div className="row">
        <div className="field" style={{ flex: 1 }}><label>Subject (holder)</label><input className="mono" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>Nonce</label><input className="mono" value={nonce} onChange={(e) => setNonce(e.target.value)} /></div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={doMint}>Verify &amp; mint (simulation)</button>
        <button className="btn" onClick={doMint}>Replay same attestation</button>
        <button className="btn danger" onClick={revoke}>Revoke attestation</button>
      </div>
      <p className="muted small mt">Try “Replay same attestation” twice: the second mint is rejected with REPLAYED_NONCE — one attestation, one mint.</p>
      <h4 className="section-title">Mint records ({state.minted.length})</h4>
      <table className="data"><thead><tr><th>Attestation</th><th>Subject</th><th className="num">Amount</th></tr></thead>
        <tbody>{state.minted.map((m, i) => <tr key={i}><td className="mono">{m.attestationId}</td><td className="mono">{m.subject}</td><td className="num mono">{m.amount.toString()}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function VaultSim({ form }: { form: VaultForm }) {
  const lb = parseInt(form.withdrawalLimitBps, 10);
  const fb = parseInt(form.redeemFeeBps, 10);
  const configOk = (() => { try { validateVaultConfig(lb, fb); return true; } catch { return false; } })();
  const [state, setState] = useState<VaultState>(() => ({
    totalCollateral: 1_000_000n,
    totalShares: 1_000_000n,
    withdrawalLimitBps: Number.isInteger(lb) ? lb : 0,
    redeemFeeBps: Number.isInteger(fb) ? fb : 0,
  }));
  const [depAmt, setDepAmt] = useState('10000');
  const [rdmAmt, setRdmAmt] = useState('5000');
  const [err, setErr] = useState('');

  // Keep the simulated fee/limit in sync with the form when the config is valid.
  const cfgKey = `${lb}:${fb}:${configOk}`;
  const [seenKey, setSeenKey] = useState(cfgKey);
  if (cfgKey !== seenKey) {
    setSeenKey(cfgKey);
    if (configOk) setState((s) => ({ ...s, withdrawalLimitBps: lb, redeemFeeBps: fb }));
  }

  const act = (fn: () => VaultState) => {
    try { setState(fn()); setErr(''); } catch (e) { setErr((e as Error).message); }
  };

  if (!configOk) return <div className="warn blocking"><span className="sev">Config error</span><br />Withdrawal limit and fee must be integers 0–10000 bps.</div>;

  const limit = withdrawalLimitAmount(state);
  const ratio = collateralRatioBps(state.totalCollateral, state.totalShares);

  return (
    <div>
      {err && <div className="warn blocking"><span className="sev">Rejected</span><br />{err}</div>}
      <p className="small">State: collateral <span className="mono">{state.totalCollateral.toString()}</span> · shares <span className="mono">{state.totalShares.toString()}</span> · limit <span className="mono">{state.withdrawalLimitBps} bps</span> (cap <span className="mono">{limit.toString()}</span> units/redemption) · fee <span className="mono">{state.redeemFeeBps} bps</span> · ratio <span className="mono">{ratio === U64_MAX ? 'u64::MAX (no claims)' : `${ratio.toString()} bps`}</span></p>
      <div className="grid cols-2">
        <div>
          <div className="field"><label>Deposit amount (collateral base units)</label><input value={depAmt} onChange={(e) => setDepAmt(e.target.value)} inputMode="numeric" /></div>
          <button className="btn" onClick={() => { const a = bi(depAmt); if (a !== null) act(() => simulateDeposit(state, a).newState); }}>Deposit (simulation)</button>
          <p className="muted small">Shares mint floored pro-rata (1:1 on first deposit); dust is rejected.</p>
        </div>
        <div>
          <div className="field"><label>Shares to redeem</label><input value={rdmAmt} onChange={(e) => setRdmAmt(e.target.value)} inputMode="numeric" /></div>
          <button className="btn" onClick={() => { const s = bi(rdmAmt); if (s !== null) act(() => simulateRedeem(state, s).newState); }}>Redeem (simulation)</button>
          <p className="muted small">Gross floors in the vault's favor; fee rounds up; redemptions above the cap are rejected.</p>
        </div>
      </div>
      <p className="muted small">Collateral here is {form.mockLabel} — no gold backing, no redemption value, devnet only, never labeled PAXG.</p>
      <button className="btn ghost mt" onClick={() => setState({ totalCollateral: 1_000_000n, totalShares: 1_000_000n, withdrawalLimitBps: lb, redeemFeeBps: fb })}>Reset simulation state</button>
    </div>
  );
}
