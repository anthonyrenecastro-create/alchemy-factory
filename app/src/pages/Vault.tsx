import { useState } from 'react';
import {
  simulateDeposit, simulateRedeem, withdrawalLimitAmount, collateralRatioBps,
  validateVaultConfig, U64_MAX,
  type VaultState,
} from '@sdk';
import { HonestyBanner } from '../components/HonestyBanner';

const bi = (s: string): bigint | null => {
  try {
    const v = BigInt(s.trim());
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
};

function fmtRatio(r: bigint): string {
  if (r === U64_MAX) return 'u64::MAX — no outstanding claims';
  return `${r.toString()} bps (${(Number(r) / 100).toFixed(2)}%)`;
}

/**
 * Vault — deposit/redeem simulator for the stage-3 collateral vault.
 * SIMULATION ONLY: runs the deterministic SDK mirror of `alchemy_vault`
 * (same math, same rounding, same error names). The on-chain program is
 * UNVERIFIED — not deployed to devnet, no end-to-end devnet transaction.
 * Collateral here is MOCK-GOLD, never PAXG.
 */
export function Vault() {
  const [limitBps, setLimitBps] = useState('1000');
  const [feeBps, setFeeBps] = useState('30');
  const [startCollateral, setStartCollateral] = useState('1000000');
  const [startShares, setStartShares] = useState('1000000');
  const [state, setState] = useState<VaultState>({ totalCollateral: 1_000_000n, totalShares: 1_000_000n, withdrawalLimitBps: 1000, redeemFeeBps: 30 });
  const [configErr, setConfigErr] = useState('');
  const [depositAmt, setDepositAmt] = useState('10000');
  const [redeemAmt, setRedeemAmt] = useState('5000');
  const [lastDeposit, setLastDeposit] = useState<{ amount: bigint; shares: bigint } | null>(null);
  const [lastRedeem, setLastRedeem] = useState<{ shares: bigint; gross: bigint; fee: bigint; net: bigint } | null>(null);
  const [opErr, setOpErr] = useState('');

  const applyConfig = () => {
    const lb = parseInt(limitBps, 10);
    const fb = parseInt(feeBps, 10);
    const c = bi(startCollateral);
    const s = bi(startShares);
    try {
      if (!Number.isInteger(lb) || !Number.isInteger(fb)) throw new Error('InvalidBps');
      validateVaultConfig(lb, fb);
      if (c === null || s === null) throw new Error('Enter non-negative integer collateral and shares.');
      setState({ totalCollateral: c, totalShares: s, withdrawalLimitBps: lb, redeemFeeBps: fb });
      setLastDeposit(null);
      setLastRedeem(null);
      setConfigErr('');
    } catch (e) {
      setConfigErr((e as Error).message);
    }
  };

  const doDeposit = () => {
    const a = bi(depositAmt);
    if (a === null) { setOpErr('Enter a non-negative integer amount.'); return; }
    try {
      const r = simulateDeposit(state, a);
      setState(r.newState);
      setLastDeposit({ amount: a, shares: r.shares });
      setOpErr('');
    } catch (e) {
      setOpErr(`Deposit rejected: ${(e as Error).message}`);
    }
  };

  const doRedeem = () => {
    const s = bi(redeemAmt);
    if (s === null) { setOpErr('Enter a non-negative integer share amount.'); return; }
    try {
      const r = simulateRedeem(state, s);
      setState(r.newState);
      setLastRedeem({ shares: s, gross: r.gross, fee: r.fee, net: r.net });
      setOpErr('');
    } catch (e) {
      setOpErr(`Redeem rejected: ${(e as Error).message}`);
    }
  };

  const limit = withdrawalLimitAmount(state);
  const ratio = collateralRatioBps(state.totalCollateral, state.totalShares);

  return (
    <div className="page">
      <h1>Collateral vault simulator</h1>
      <p className="lede">
        An ERC-4626-style segregated vault: deposit collateral, mint pro-rata shares; burn shares, redeem
        pro-rata collateral minus fees — subject to a withdrawal limit that protects solvency. The vault
        program publishes a read-only proof account anyone can recompute.
      </p>
      <HonestyBanner mode="simulation">
        This is a <strong>simulation</strong>: local deterministic math mirroring the on-chain vault program.
        The on-chain <span className="mono">alchemy_vault</span> program is <strong>UNVERIFIED</strong> — not
        deployed to devnet and no end-to-end devnet transaction has succeeded. Nothing here is a promise of
        yield, a price floor, or production readiness.
      </HonestyBanner>
      <div className="warn blocking" role="note">
        <span className="sev">MOCK-GOLD — devnet only</span><br />
        MOCK-GOLD is mock collateral with <strong>no gold backing</strong> and <strong>no redemption value</strong> —
        devnet only. It is <strong>never labeled PAXG</strong>, and no devnet token may be labeled PAXG.
      </div>

      <div className="grid cols-2 mt">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Vault configuration <span className="badge sim">simulation</span></h3>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Withdrawal limit (bps)</label><input value={limitBps} onChange={(e) => setLimitBps(e.target.value)} inputMode="numeric" /><span className="hint">100 bps = 1%. 10000 = effectively no limit (cap floors at the full balance).</span></div>
            <div className="field" style={{ flex: 1 }}><label>Redemption fee (bps)</label><input value={feeBps} onChange={(e) => setFeeBps(e.target.value)} inputMode="numeric" /><span className="hint">Rounded up on every redemption.</span></div>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}><label>Starting collateral (base units)</label><input value={startCollateral} onChange={(e) => setStartCollateral(e.target.value)} inputMode="numeric" /></div>
            <div className="field" style={{ flex: 1 }}><label>Starting shares (base units)</label><input value={startShares} onChange={(e) => setStartShares(e.target.value)} inputMode="numeric" /></div>
          </div>
          {configErr && <div className="warn blocking"><span className="sev">Config error</span><br />{configErr}</div>}
          <button className="btn primary mt" onClick={applyConfig}>Apply configuration</button>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Vault state <span className="badge sim">simulation</span></h3>
          <table className="data"><tbody>
            <tr><td>Total collateral</td><td className="num mono">{state.totalCollateral.toString()}</td></tr>
            <tr><td>Total shares</td><td className="num mono">{state.totalShares.toString()}</td></tr>
            <tr><td>Share price</td><td className="num mono">{state.totalShares === 0n ? '—' : `${(state.totalCollateral / state.totalShares).toString()} collateral / share (floored)`}</td></tr>
            <tr><td>Withdrawal limit</td><td className="num mono">{state.withdrawalLimitBps} bps → <strong>{limit.toString()}</strong> collateral units / redemption</td></tr>
            <tr><td>Redemption fee</td><td className="num mono">{state.redeemFeeBps} bps (rounded up)</td></tr>
          </tbody></table>
        </div>
      </div>

      {opErr && <div className="warn blocking mt"><span className="sev">Rejected</span><br />{opErr}</div>}

      <div className="grid cols-2 mt">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Deposit <span className="badge sim">simulation</span></h3>
          <div className="field"><label>Deposit amount (collateral base units)</label><input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} inputMode="numeric" /></div>
          <button className="btn primary" onClick={doDeposit}>Deposit (simulation)</button>
          {lastDeposit && (
            <table className="data mt"><tbody>
              <tr><td>Deposited</td><td className="num mono">{lastDeposit.amount.toString()}</td></tr>
              <tr><td><strong>Shares minted</strong></td><td className="num mono"><strong>{lastDeposit.shares.toString()}</strong></td></tr>
            </tbody></table>
          )}
          <p className="muted small">Shares mint pro-rata: <span className="mono">⌊amount × totalShares / totalCollateral⌋</span> (1:1 on first deposit). The floor protects existing holders — any remainder stays in the vault. A deposit that would mint zero shares is rejected as dust, not absorbed for nothing.</p>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Redeem <span className="badge sim">simulation</span></h3>
          <div className="field"><label>Shares to burn</label><input value={redeemAmt} onChange={(e) => setRedeemAmt(e.target.value)} inputMode="numeric" /></div>
          <button className="btn primary" onClick={doRedeem}>Redeem (simulation)</button>
          {lastRedeem && (
            <table className="data mt"><tbody>
              <tr><td>Shares burned</td><td className="num mono">{lastRedeem.shares.toString()}</td></tr>
              <tr><td>Gross collateral</td><td className="num mono">{lastRedeem.gross.toString()}</td></tr>
              <tr><td>Fee (rounded up)</td><td className="num mono">−{lastRedeem.fee.toString()}</td></tr>
              <tr><td><strong>Net you receive</strong></td><td className="num mono"><strong>{lastRedeem.net.toString()}</strong></td></tr>
            </tbody></table>
          )}
          <p className="muted small">Gross = <span className="mono">⌊shares × totalCollateral / totalShares⌋</span>, floored in the vault's favor so it can never pay out more than the shares are worth. Redeems above the withdrawal limit are rejected (<span className="mono">WithdrawalLimitExceeded</span>); the limit itself floors, so it is never rounded past the configured bps.</p>
        </div>
      </div>

      <div className="card mt">
        <h3 style={{ marginTop: 0 }}>Collateral ratio <span className="badge sim">simulation</span></h3>
        <p>Current ratio: <strong className="mono">{fmtRatio(ratio)}</strong></p>
        <p className="muted small" style={{ marginBottom: 0 }}>
          Ratio = <span className="mono">⌊totalCollateral × 10000 / totalShares⌋</span> bps. When there are no
          outstanding claims there is nothing to divide by, so the program reports <span className="mono">u64::MAX</span>
          (2⁶⁴−1) as a sentinel — that means "no claims exist", <strong>not</strong> infinite collateral or a
          guaranteed backing multiple. Below 10000 bps the vault is undercollateralized: not all claims can be met.
        </p>
      </div>

      <div className="card mt">
        <h3 style={{ marginTop: 0 }}>Proof accounts — independently verifiable <span className="badge sim">simulation</span></h3>
        <p className="small">
          The on-chain <span className="mono">publish_proof</span> instruction writes a read-only
          <span className="mono"> VaultProof</span> snapshot that anyone can recompute from public chain state —
          the vault's token-account balance and the share mint's supply. A proof is a signed snapshot, not a
          guarantee of future value.
        </p>
        <table className="data">
          <thead><tr><th>Field</th><th>What it publishes</th></tr></thead>
          <tbody>
            <tr><td className="mono">vault</td><td>The vault config account this proof belongs to.</td></tr>
            <tr><td className="mono">total_collateral</td><td>Collateral units in the vault token account at publish time.</td></tr>
            <tr><td className="mono">outstanding_claims</td><td>Outstanding contractual claims (shares converted at the current ratio).</td></tr>
            <tr><td className="mono">collateral_ratio_bps</td><td><span className="mono">total_collateral × 10000 / outstanding_claims</span>; u64::MAX when no claims exist.</td></tr>
            <tr><td className="mono">authority</td><td>Current admin authority of the vault.</td></tr>
            <tr><td className="mono">treasury</td><td>Fee-recipient account.</td></tr>
            <tr><td className="mono">is_mock_collateral</td><td>True on devnet: the collateral is MOCK-GOLD, not PAXG.</td></tr>
            <tr><td className="mono">published_ts</td><td>Slot timestamp of the snapshot.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
