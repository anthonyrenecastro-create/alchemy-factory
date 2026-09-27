import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { MECHANIC_LABELS, quoteBuy, quoteSell, linearFromPerToken, type CurveConfig } from '@sdk';
import { HonestyBanner } from '../components/HonestyBanner';
import { SAMPLE_TOKENS, type SampleToken } from '../data/samples';

const bi = (s: string): bigint | null => {
  try {
    const v = BigInt(s.trim());
    return v >= 0n ? v : null;
  } catch {
    return null;
  }
};

function AuthorityRow({ label, value, dangerous }: { label: string; value: string | null; dangerous?: boolean }) {
  return (
    <tr>
      <td>{label}</td>
      <td className="mono small">
        {value ? <span style={dangerous ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{value}</span> : <span className="muted">none</span>}
        {dangerous && value && <div className="warn blocking" style={{ marginTop: '0.4rem' }}><span className="sev">Blocking</span><br />This authority can move or burn anyone's tokens without consent.</div>}
      </td>
    </tr>
  );
}

/**
 * Token detail — authorities, collateral, redemption, expiry, fees, and risks
 * are ALL shown before any sign action. Trade/transfer forms run the SDK in
 * simulation mode and are labeled as such.
 */
export function TokenDetail() {
  const { mint } = useParams<{ mint: string }>();
  const token: SampleToken | undefined = SAMPLE_TOKENS.find((t) => t.mint === mint);
  const { connected } = useWallet();

  const [transferTo, setTransferTo] = useState('');
  const [transferAmt, setTransferAmt] = useState('');
  const [tradeAmt, setTradeAmt] = useState('100');
  const [tradeSide, setTradeSide] = useState<'buy' | 'sell'>('buy');
  const [simNote, setSimNote] = useState('');

  // Sample curve for the buy/sell simulator (only meaningful for curve tokens,
  // but shown in simulation mode for any sample to demonstrate quoting).
  const curveConfig: CurveConfig = useMemo(
    () => linearFromPerToken(1000n, 2n, 30),
    [],
  );
  const tradeQuote = useMemo(() => {
    const a = bi(tradeAmt);
    if (!a) return null;
    try {
      return tradeSide === 'buy'
        ? quoteBuy({ supply: 1_000_000n, reserve: 10_000_000n }, curveConfig, a)
        : quoteSell({ supply: 1_000_000n, reserve: 10_000_000n }, curveConfig, a);
    } catch {
      return null;
    }
  }, [tradeAmt, tradeSide, curveConfig]);

  if (!token) {
    return (
      <div className="page">
        <HonestyBanner mode="mixed" />
        <div className="warn blocking"><span className="sev">Unknown token</span><br />No sample token matches this mint. <Link to="/holder">Back to discovery</Link>.</div>
      </div>
    );
  }

  return (
    <div className="page">
      <p><Link to="/holder">← Discovery</Link></p>
      <h1>{token.name} <span className="muted">({token.symbol})</span></h1>
      <p className="lede">{token.description}</p>
      <HonestyBanner mode="mixed">
        <span className="badge sample">Sample token</span> Balances, trades, and history below are <strong>sample/simulation data</strong>, not chain state.
      </HonestyBanner>

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Token identity</h3>
          <dl className="kv">
            <dt>Mint</dt><dd className="mono small">{token.mint} <span className="badge sample">sample</span></dd>
            <dt>Mechanic</dt><dd>{MECHANIC_LABELS[token.mechanic]}</dd>
            <dt>Extensions</dt><dd className="mono small">{token.extensions.join(', ') || 'none'}</dd>
            <dt>Your balance</dt><dd>{token.sampleBalance} <span className="muted small">(sample)</span></dd>
            {token.expiry && <><dt>Expiry</dt><dd>{token.expiry}</dd></>}
            {token.collateral && <><dt>Collateral</dt><dd>{token.collateral}</dd></>}
          </dl>

          <h3 className="section-title">Live authorities — read before signing</h3>
          <table className="data"><tbody>
            <AuthorityRow label="Mint authority" value={token.authorities.mintAuthority} />
            <AuthorityRow label="Freeze authority" value={token.authorities.freezeAuthority} />
            <AuthorityRow label="Update authority" value={token.authorities.updateAuthority} />
            <AuthorityRow label="Permanent delegate" value={token.authorities.permanentDelegate} dangerous />
            <AuthorityRow label="Transfer hook" value={token.authorities.transferHookProgram} />
          </tbody></table>

          <h3 className="section-title">Terms, fees, risks</h3>
          <dl className="kv">
            <dt>Fees</dt><dd>{token.fees}</dd>
            <dt>Redemption</dt><dd>{token.redemptionTerms}</dd>
          </dl>
          <ul className="small">
            {token.risks.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>

        <div>
          <div className="explainer">
            <h3>Why this token behaves this way</h3>
            <p className="small">{token.whyItBehaves}</p>
          </div>

          <div className="card mt">
            <h3 style={{ marginTop: 0 }}>Wallet</h3>
            <WalletMultiButton />
            {!connected && <p className="muted small mt">Not connected — everything below still works in simulation mode. Nothing here requires a wallet.</p>}
          </div>

          <div className="card mt">
            <h3 style={{ marginTop: 0 }}>Transfer <span className="badge sim">simulation</span></h3>
            {!token.transfersPermitted ? (
              <div className="warn blocking"><span className="sev">Disabled</span><br />{token.transferBlockReason}</div>
            ) : (
              <>
                <div className="field"><label>Recipient</label><input className="mono" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} placeholder="base58 address" /></div>
                <div className="field"><label>Amount</label><input value={transferAmt} onChange={(e) => setTransferAmt(e.target.value)} inputMode="numeric" /></div>
                <button className="btn" disabled={!transferTo || !transferAmt} onClick={() => setSimNote(`Simulated transfer of ${transferAmt} ${token.symbol} to ${transferTo.slice(0, 12)}… — no transaction sent.`)}>Simulate transfer</button>
              </>
            )}
            {simNote && <p className="small mt">{simNote}</p>}
          </div>

          {token.tradingSupported && (
            <div className="card mt">
              <h3 style={{ marginTop: 0 }}>Buy / Sell <span className="badge sim">simulation</span></h3>
              <div className="tabs">
                <button className={`tab${tradeSide === 'buy' ? ' active' : ''}`} onClick={() => setTradeSide('buy')}>Buy</button>
                <button className={`tab${tradeSide === 'sell' ? ' active' : ''}`} onClick={() => setTradeSide('sell')}>Sell</button>
              </div>
              <div className="field"><label>Amount (token base units)</label><input value={tradeAmt} onChange={(e) => setTradeAmt(e.target.value)} inputMode="numeric" /></div>
              {tradeQuote ? (
                <table className="data"><tbody>
                  <tr><td>{tradeSide === 'buy' ? 'You pay (incl. fee)' : 'You receive (net)'}</td><td className="num mono"><strong>{tradeQuote.total.toString()}</strong></td></tr>
                  <tr><td>Fee (rounded up)</td><td className="num mono">{tradeQuote.fee.toString()}</td></tr>
                  <tr><td>Avg price / token</td><td className="num mono">{tradeQuote.avgPrice.toString()}</td></tr>
                  <tr><td>Price impact</td><td className="num mono">{tradeQuote.priceImpactBps.toString()} bps</td></tr>
                </tbody></table>
              ) : (
                <p className="muted small">Enter a valid amount for a quote.</p>
              )}
              <p className="muted small">Quotes use the SDK's exact integer math (fees rounded up). Simulation only — no order is placed.</p>
            </div>
          )}

          {token.vaultHoldings && (
            <div className="card mt">
              <h3 style={{ marginTop: 0 }}>Vault holdings <span className="badge sample">sample</span></h3>
              <table className="data"><thead><tr><th>Mint</th><th>Amount</th></tr></thead>
                <tbody>{token.vaultHoldings.map((h) => <tr key={h.mint}><td className="mono small">{h.mint.slice(0, 16)}…</td><td>{h.amount}</td></tr>)}</tbody>
              </table>
            </div>
          )}

          {token.proofStatus && (
            <div className="card mt">
              <h3 style={{ marginTop: 0 }}>Proof status <span className="badge sample">sample</span></h3>
              <table className="data"><thead><tr><th>Attestation</th><th>Claim</th><th>Status</th></tr></thead>
                <tbody>{token.proofStatus.map((p) => <tr key={p.attestationId}><td className="mono small">{p.attestationId}</td><td className="small">{p.claimType}</td><td><span className={`badge ${p.status === 'valid' ? 'verified' : 'unverified'}`}>{p.status}</span></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <h2 className="section-title">Transaction history <span className="badge sample">sample data</span></h2>
      <div className="card">
        <table className="data">
          <thead><tr><th>Signature</th><th>Type</th><th>Amount</th><th>Time</th></tr></thead>
          <tbody>
            {token.txHistory.map((tx) => (
              <tr key={tx.sig}><td className="mono small">{tx.sig}</td><td>{tx.kind}</td><td className="mono">{tx.amount}</td><td className="small">{tx.time}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
