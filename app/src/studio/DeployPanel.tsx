import { useState } from 'react';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  createInitializeMint2Instruction,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { ExperimentConfig, MechanicKind } from '@sdk';

/**
 * Test → deploy pipeline for the studio (devnet only).
 *
 * Step 1 "Test": requires the studio simulation to have been visited, plus an
 * explicit "reviewed" acknowledgment.
 * Step 2 "Connect": wallet-adapter connect (Phantom/Solflare).
 * Step 3 "Create mint": a REAL devnet Token-2022 mint, mint authority = the
 * connected wallet. Signature + Solscan devnet link shown.
 * Step 4 "Deploy mechanic": pilot for the `curve` mechanic only. Builds the
 * `initialize_curve` instruction by hand (no Anchor client): discriminator =
 * sha256("global:initialize_curve")[0..8], borsh args, exact account order
 * from programs/programs/alchemy_curve/src/lib.rs. The program account is
 * checked with getAccountInfo first — if it is not deployed/executable on
 * devnet, the step shows an honest blocked state and NO transaction is sent.
 *
 * Honesty: everything here is devnet-only; programs are UNVERIFIED; devnet
 * collateral is MOCK-GOLD, never PAXG; no mainnet claims anywhere.
 */

const CURVE_PROGRAM_ID = new PublicKey('6fFjhEQx73RZ5sYJLtsyWo53ZDgvfV4YokLdrLh2DPDL');
const SOLSCAN_TX = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;

export interface CurveInitParams {
  kind: 'linear' | 'step';
  decimals: number;
  /** On-chain scaled slope for Linear (price(s) = intercept + slope*s/PRICE_SCALE). */
  slope: bigint;
  /** On-chain intercept for Linear (quote base units per token base unit). */
  intercept: bigint;
  /** Step points for the Step template. */
  steps: { supply: bigint; price: bigint }[];
  feeBps: number;
}

interface DeployPanelProps {
  /** True once the user has reached the studio's simulation step. */
  simulated: boolean;
  mechanic: MechanicKind;
  experiment: ExperimentConfig | null;
  /** Curve init params derived from the studio form (curve mechanic only). */
  curveInit: CurveInitParams | null;
}

type Stage = 'test' | 'connect' | 'mint' | 'deploy';

const U128_MAX = 2n ** 128n - 1n;

function writeU128LE(view: DataView, offset: number, v: bigint) {
  if (v < 0n || v > U128_MAX) throw new Error(`u128 out of range: ${v}`);
  view.setBigUint64(offset, v & 0xffffffffffffffffn, true);
  view.setBigUint64(offset + 8, (v >> 64n) & 0xffffffffffffffffn, true);
}

async function initializeCurveDiscriminator(): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:initialize_curve'));
  return new Uint8Array(hash).slice(0, 8);
}

/**
 * Borsh-encode initialize_curve args by hand (Anchor layout):
 *   discriminator[8] | decimals u8 | CurveKind enum | fee_bps u16le | max_slippage_bps u16le
 * CurveKind: variant u8 (0 = Linear { slope u128le, intercept u128le },
 *            1 = Step { Vec<StepPoint{ supply u128le, price u128le }> }).
 */
async function encodeInitializeCurve(p: CurveInitParams, maxSlippageBps: number): Promise<Uint8Array> {
  const disc = await initializeCurveDiscriminator();
  let body: Uint8Array;
  if (p.kind === 'linear') {
    const buf = new ArrayBuffer(1 + 1 + 16 + 16 + 2 + 2);
    const view = new DataView(buf);
    view.setUint8(0, p.decimals);
    view.setUint8(1, 0); // Linear variant
    writeU128LE(view, 2, p.slope);
    writeU128LE(view, 18, p.intercept);
    view.setUint16(34, p.feeBps, true);
    view.setUint16(36, maxSlippageBps, true);
    body = new Uint8Array(buf);
  } else {
    const n = p.steps.length;
    const buf = new ArrayBuffer(1 + 1 + 4 + n * 32 + 2 + 2);
    const view = new DataView(buf);
    view.setUint8(0, p.decimals);
    view.setUint8(1, 1); // Step variant
    view.setUint32(2, n, true);
    p.steps.forEach((s, i) => {
      writeU128LE(view, 6 + i * 32, s.supply);
      writeU128LE(view, 6 + i * 32 + 16, s.price);
    });
    view.setUint16(6 + n * 32, p.feeBps, true);
    view.setUint16(6 + n * 32 + 2, maxSlippageBps, true);
    body = new Uint8Array(buf);
  }
  const out = new Uint8Array(disc.length + body.length);
  out.set(disc, 0);
  out.set(body, disc.length);
  return out;
}

export function DeployPanel({ simulated, mechanic, experiment, curveInit }: DeployPanelProps) {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();

  const [stage, setStage] = useState<Stage>('test');
  const [tested, setTested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mintAddress, setMintAddress] = useState<string | null>(null);
  const [mintSig, setMintSig] = useState<string | null>(null);

  const [programBlocked, setProgramBlocked] = useState(false);
  const [programChecked, setProgramChecked] = useState(false);
  const [deploySig, setDeploySig] = useState<string | null>(null);
  const [curveMint, setCurveMint] = useState<string | null>(null);
  const [slippageBps, setSlippageBps] = useState('500');

  const isCurvePilot = mechanic === 'curve' && curveInit !== null;

  const stageIndex = (s: Stage) => ['test', 'connect', 'mint', 'deploy'].indexOf(s);
  const doneUpTo = (s: Stage) => stageIndex(stage) > stageIndex(s);

  const createMint = async () => {
    if (!publicKey || !sendTransaction || !experiment) return;
    setBusy(true);
    setError(null);
    try {
      const mintKeypair = Keypair.generate();
      const lamports = await getMinimumBalanceForRentExemptMint(connection);
      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: publicKey,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      });
      const initMintIx = createInitializeMint2Instruction(
        mintKeypair.publicKey,
        experiment.decimals,
        publicKey, // mint authority = connected wallet
        null, // no freeze authority
        TOKEN_2022_PROGRAM_ID,
      );
      const sig = await sendTransaction(new Transaction().add(createAccountIx, initMintIx), connection, {
        signers: [mintKeypair],
      });
      await connection.confirmTransaction(sig, 'confirmed');
      setMintAddress(mintKeypair.publicKey.toBase58());
      setMintSig(sig);
      setStage('deploy');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deployCurve = async () => {
    if (!publicKey || !sendTransaction || !curveInit) return;
    setBusy(true);
    setError(null);
    setProgramBlocked(false);
    try {
      // Honest gate: never send the instruction unless the program is live.
      const info = await connection.getAccountInfo(CURVE_PROGRAM_ID);
      setProgramChecked(true);
      if (!info || !info.executable) {
        setProgramBlocked(true);
        return;
      }

      const slippage = Math.max(0, Math.min(10_000, parseInt(slippageBps, 10) || 0));
      const data = await encodeInitializeCurve(curveInit, slippage);

      // NOTE: initialize_curve CREATES its own mint (mint authority = the
      // curve config PDA) — it needs a fresh uninitialized keypair, so this
      // is a separate mint from the step-3 wallet-owned mint.
      const mintKeypair = Keypair.generate();
      const [curveConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from('curve'), mintKeypair.publicKey.toBuffer()],
        CURVE_PROGRAM_ID,
      );
      const [vault] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), mintKeypair.publicKey.toBuffer()],
        CURVE_PROGRAM_ID,
      );

      // Account order mirrors `InitializeCurve` in alchemy_curve/src/lib.rs:
      // authority, curve_config, mint, vault, treasury, token_program,
      // system_program, rent.
      const ix = new TransactionInstruction({
        programId: CURVE_PROGRAM_ID,
        data: Buffer.from(data),
        keys: [
          { pubkey: publicKey, isSigner: true, isWritable: true }, // authority
          { pubkey: curveConfig, isSigner: false, isWritable: true }, // curve_config (PDA)
          { pubkey: mintKeypair.publicKey, isSigner: true, isWritable: true }, // mint (created by ix)
          { pubkey: vault, isSigner: false, isWritable: true }, // vault (PDA)
          { pubkey: publicKey, isSigner: false, isWritable: false }, // treasury (fee recipient)
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
      });

      const sig = await sendTransaction(new Transaction().add(ix), connection, { signers: [mintKeypair] });
      await connection.confirmTransaction(sig, 'confirmed');
      setCurveMint(mintKeypair.publicKey.toBase58());
      setDeploySig(sig);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stages: { id: Stage; label: string }[] = [
    { id: 'test', label: 'Test' },
    { id: 'connect', label: 'Connect' },
    { id: 'mint', label: 'Create mint' },
    { id: 'deploy', label: 'Deploy mechanic' },
  ];

  return (
    <div className="card mt">
      <h3 style={{ marginTop: 0 }}>
        Test → deploy <span className="badge devnet">devnet</span>{' '}
        <span className="badge unverified">programs unverified</span>
      </h3>
      <p className="muted small" style={{ marginTop: '-0.5rem' }}>
        Real devnet transactions. Programs are UNVERIFIED (no audit, no devnet end-to-end run yet).
        Devnet mints have no value; devnet collateral is MOCK-GOLD — never PAXG. Nothing here touches mainnet.
      </p>

      <div className="pipe">
        {stages.map((s, i) => (
          <span
            key={s.id}
            className={`pipe-step${stage === s.id ? ' active' : ''}${doneUpTo(s.id) || (s.id === 'deploy' && deploySig) ? ' done' : ''}`}
          >
            <span className="n">{i + 1}</span> {s.label}
          </span>
        ))}
      </div>

      {error && (
        <div className="warn blocking">
          <span className="sev">Transaction failed</span>
          <br />
          <span className="mono small">{error}</span>
        </div>
      )}

      {/* ---- Step 1: Test ---- */}
      {stage === 'test' && (
        <div>
          {!simulated ? (
            <div className="warn blocking">
              <span className="sev">Blocked</span>
              <br />
              Run the simulation first — the deploy pipeline unlocks after the studio's simulation step.
            </div>
          ) : (
            <div>
              <p className="small">
                Simulation reviewed for <strong>{experiment?.name ?? 'Untitled Experiment'}</strong>{' '}
                <span className="mono">
                  ({experiment?.symbol}, {experiment?.decimals} decimals, {mechanic})
                </span>
                . Confirm the simulated numbers above match your intent before creating anything on devnet.
              </p>
              <button className="btn primary" disabled={busy} onClick={() => { setTested(true); setStage('connect'); }}>
                Simulation reviewed — continue to devnet
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- Step 2: Connect ---- */}
      {stage === 'connect' && (
        <div>
          {!tested && <p className="small muted">Step 1 not completed.</p>}
          {tested && !connected && (
            <div>
              <p className="small">Connect a devnet wallet to sign. This uses devnet SOL from the faucet — never mainnet funds.</p>
              <WalletMultiButton />
            </div>
          )}
          {tested && connected && (
            <div>
              <p className="small">
                Connected: <span className="mono">{publicKey?.toBase58()}</span>
              </p>
              <button className="btn primary" onClick={() => setStage('mint')}>
                Continue — create the mint
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- Step 3: Create mint (real devnet tx) ---- */}
      {stage === 'mint' && (
        <div>
          {!mintSig ? (
            <div>
              <p className="small">
                Creates a real <strong>Token-2022</strong> mint on <strong>devnet</strong> with{' '}
                <span className="mono">{experiment?.decimals ?? 6}</span> decimals. Mint authority = your connected
                wallet. No extensions — plain Token-2022, maximum compatibility. Costs devnet SOL (rent + fees).
              </p>
              <button className="btn primary" disabled={busy || !connected} onClick={createMint}>
                {busy ? 'Sending…' : 'Create Token-2022 mint on devnet'}
              </button>
              {!connected && <p className="small muted">Connect a wallet first.</p>}
            </div>
          ) : (
            <div>
              <div className="warn info">
                <span className="sev">Devnet mint created</span>
                <br />
                Mint: <span className="mono">{mintAddress}</span>
              </div>
              <p className="small">Transaction (devnet):</p>
              <div className="sig">{mintSig}</div>
              <p className="small mt">
                <a href={SOLSCAN_TX(mintSig)} target="_blank" rel="noreferrer">
                  View on Solscan (devnet) ↗
                </a>
              </p>
              <button className="btn primary" onClick={() => setStage('deploy')}>
                Continue — deploy the mechanic
              </button>
            </div>
          )}
        </div>
      )}

      {/* ---- Step 4: Deploy mechanic (curve pilot) ---- */}
      {stage === 'deploy' && (
        <div>
          {!isCurvePilot ? (
            <div className="warn info">
              <span className="sev">Simulate only</span>
              <br />
              The <span className="mono">{mechanic}</span> mechanic has no live deploy path yet —{' '}
              <strong>curve is the live pilot</strong>; other mechanics simulate only for now. Your step-3 mint above
              is a real devnet Token-2022 mint you own and can experiment with freely.
            </div>
          ) : (
            <div>
              <p className="small">
                Pilot: <strong>curve</strong> mechanic via <span className="mono">initialize_curve</span> on program{' '}
                <span className="mono">{CURVE_PROGRAM_ID.toBase58()}</span>. The instruction is built by hand
                (discriminator = sha256("global:initialize_curve")[0..8], borsh args, exact account order from the
                program source). The program creates its own mint with the curve config PDA as mint authority — a
                separate mint from step 3.
              </p>
              <div className="field" style={{ maxWidth: 280 }}>
                <label>Max slippage (bps)</label>
                <input value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} inputMode="numeric" />
              </div>
              {programBlocked ? (
                <div className="warn blocking">
                  <span className="sev">Blocked — program not deployed</span>
                  <br />
                  The curve program is <strong>not deployed / not executable on devnet</strong> yet
                  {programChecked ? ' (checked just now via getAccountInfo)' : ''}. No transaction was sent. Your
                  step-3 mint is unaffected. Mechanic init unlocks after the program is deployed to devnet.
                </div>
              ) : (
                <button className="btn primary" disabled={busy || !connected || !!deploySig} onClick={deployCurve}>
                  {busy ? 'Sending…' : 'Initialize curve on devnet'}
                </button>
              )}
              {deploySig && (
                <div className="mt">
                  <div className="warn info">
                    <span className="sev">Curve initialized (devnet)</span>
                    <br />
                    Curve mint: <span className="mono">{curveMint}</span> (mint authority = curve config PDA)
                  </div>
                  <div className="sig">{deploySig}</div>
                  <p className="small mt">
                    <a href={SOLSCAN_TX(deploySig)} target="_blank" rel="noreferrer">
                      View on Solscan (devnet) ↗
                    </a>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <p className="muted small mt" style={{ marginBottom: 0 }}>
        Devnet only. Programs UNVERIFIED. MOCK-GOLD is never PAXG. No mainnet action exists in this build.
      </p>
    </div>
  );
}
