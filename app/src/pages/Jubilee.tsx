import { useMemo, useState } from 'react';
import {
  simulateJubileeSim, holderOutcomeSim, insolvencyCheckSim, jubileeFailureCasesSim,
  JUBILEE_MONTHLY_REDUCTION_BPS_SIM, JUBILEE_TREASURY_NAME_SIM, JUBILEE_COLLATERAL_LABEL_SIM,
} from '@sdk';
import { HonestyBanner } from '../components/HonestyBanner';

const bi = (s: string): bigint | null => {
  try {
    const v = BigInt(s.trim());
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

/**
 * Jubilee — ILLUSTRATIVE SIMULATION ONLY.
 * A PAXG-collateralized token is NOT implemented here; the collateral modeled
 * is MOCK-GOLD, never real PAXG. The 1%/month rule, treasury routing, holder
 * outcomes, and failure cases are computed with exact integer arithmetic.
 */
export function Jubilee() {
  const [collateral, setCollateral] = useState('1000000000');
  const [supply, setSupply] = useState('1000000');
  const [months, setMonths] = useState('12');
  const [holderTokens, setHolderTokens] = useState('100');
  const [redeemMonth, setRedeemMonth] = useState('12');
  const [missedSweeps, setMissedSweeps] = useState('');
  const [actualCollateral, setActualCollateral] = useState('');

  const params = useMemo(() => {
    const c = bi(collateral);
    const s = bi(supply);
    const m = parseInt(months, 10);
    if (!c || !s || !Number.isInteger(m) || m <= 0 || m > 120) return null;
    return { initialCollateralMockGoldSim: c, initialSupplySim: s, monthsSim: m };
  }, [collateral, supply, months]);

  const schedule = useMemo(() => (params ? simulateJubileeSim(params) : null), [params]);

  const outcome = useMemo(() => {
    if (!schedule || !params) return null;
    const h = bi(holderTokens);
    const r = parseInt(redeemMonth, 10);
    if (!h || !Number.isInteger(r) || r < 1 || r > schedule.months.length) return null;
    return holderOutcomeSim(schedule, params.initialCollateralMockGoldSim, params.initialSupplySim, h, r);
  }, [schedule, params, holderTokens, redeemMonth]);

  const missed = useMemo(
    () => missedSweeps.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0),
    [missedSweeps],
  );
  const solvencyInput = bi(actualCollateral);
  const failures = useMemo(() => {
    if (!schedule) return [];
    const last = schedule.months[schedule.months.length - 1];
    return jubileeFailureCasesSim(schedule, solvencyInput ?? last.totalClaimsSim, missed);
  }, [schedule, solvencyInput, missed]);

  const solvency = useMemo(() => {
    if (!schedule) return null;
    const last = schedule.months[schedule.months.length - 1];
    return insolvencyCheckSim(solvencyInput ?? last.totalClaimsSim, last.totalClaimsSim);
  }, [schedule, solvencyInput]);

  return (
    <div className="page">
      <h1>Jubilee simulation</h1>
      <p className="lede">
        An illustrative model of a PAXG-collateralized token whose redeemable claim decreases by a disclosed{' '}
        <strong>{JUBILEE_MONTHLY_REDUCTION_BPS_SIM} bps (1%) per month</strong>, with the removed amount routed to{' '}
        <strong>{JUBILEE_TREASURY_NAME_SIM}</strong>. Collateral here is <strong>{JUBILEE_COLLATERAL_LABEL_SIM}</strong>.
      </p>
      <HonestyBanner mode="simulation">
        This is a <strong>simulation</strong>, not a product: no vault exists, no real PAXG is involved, and nothing
        here is a promise of yield, redemption, or a price floor. It stays a simulation until vault, redemption, and
        treasury rules are built and tested (Stage 3+).
      </HonestyBanner>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Parameters <span className="badge sim">simulation</span></h3>
        <div className="grid cols-3">
          <div className="field"><label>Initial mock collateral (base units)</label><input value={collateral} onChange={(e) => setCollateral(e.target.value)} inputMode="numeric" /></div>
          <div className="field"><label>Initial token supply (base units)</label><input value={supply} onChange={(e) => setSupply(e.target.value)} inputMode="numeric" /></div>
          <div className="field"><label>Months to simulate</label><input value={months} onChange={(e) => setMonths(e.target.value)} inputMode="numeric" /></div>
        </div>
        {!params && <div className="warn blocking"><span className="sev">Invalid</span><br />Enter positive integers (months 1–120).</div>}
      </div>

      {schedule && (
        <>
          <h2 className="section-title">Monthly schedule — exact arithmetic <span className="badge sim">simulation</span></h2>
          <div className="card">
            <p className="small muted" style={{ marginTop: 0 }}>
              Rule: claim<sub>m</sub> = ⌊claim<sub>m−1</sub> × 9900 / 10000⌋. Treasury sweep<sub>m</sub> = claims<sub>m−1</sub> − claims<sub>m</sub> (exact difference — no rounding dust escapes).
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="data">
                <thead><tr><th>Month</th><th className="num">Claim / token</th><th className="num">Total claims</th><th className="num">Swept to treasury</th><th className="num">Treasury cumulative</th><th className="num">Collateral left</th></tr></thead>
                <tbody>
                  {schedule.months.map((r) => (
                    <tr key={r.month}>
                      <td>{r.month}</td>
                      <td className="num mono">{r.claimPerTokenSim.toString()}</td>
                      <td className="num mono">{r.totalClaimsSim.toString()}</td>
                      <td className="num mono">{r.treasurySweptSim.toString()}</td>
                      <td className="num mono">{r.treasuryCumulativeSim.toString()}</td>
                      <td className="num mono">{r.collateralRemainingSim.toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">Total swept to <strong>{schedule.treasuryName}</strong>: <span className="mono">{schedule.totalSweptSim.toString()}</span> mock-gold units. Conservation check: final claims + treasury = initial collateral.</p>
          </div>

          <div className="grid cols-2 mt">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>Holder outcome <span className="badge sim">simulation</span></h3>
              <div className="row">
                <div className="field" style={{ flex: 1 }}><label>Your tokens</label><input value={holderTokens} onChange={(e) => setHolderTokens(e.target.value)} inputMode="numeric" /></div>
                <div className="field" style={{ flex: 1 }}><label>Redeem in month</label><input value={redeemMonth} onChange={(e) => setRedeemMonth(e.target.value)} inputMode="numeric" /></div>
              </div>
              {outcome ? (
                <table className="data"><tbody>
                  <tr><td>Claimable at month 0</td><td className="num mono">{outcome.claimableAtMonth0Sim.toString()}</td></tr>
                  <tr><td>Claimable in month {outcome.redeemMonth}</td><td className="num mono"><strong>{outcome.claimableSim.toString()}</strong></td></tr>
                  <tr><td>Removed by the 1%/month rule</td><td className="num mono">−{outcome.removedFromHolderSim.toString()}</td></tr>
                </tbody></table>
              ) : (
                <p className="muted small">Enter a valid token amount and a month within the schedule.</p>
              )}
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Failure cases <span className="badge sim">simulation</span></h3>
              <div className="field"><label>Actual vault collateral (blank = assume full)</label><input value={actualCollateral} onChange={(e) => setActualCollateral(e.target.value)} inputMode="numeric" placeholder="optional" /></div>
              <div className="field"><label>Missed treasury sweeps (months, comma-separated)</label><input value={missedSweeps} onChange={(e) => setMissedSweeps(e.target.value)} placeholder="e.g. 3, 7" /></div>
              {solvency && (
                <p className="small">Solvency: <strong style={{ color: solvency.solvent ? 'var(--accent)' : 'var(--danger)' }}>{solvency.solvent ? 'SOLVENT' : 'INSOLVENT'}</strong>
                  {!solvency.solvent && <span> — shortfall <span className="mono">{solvency.shortfall.toString()}</span> mock-gold units: not all holders can redeem.</span>}</p>
              )}
              {failures.map((f) => (
                <div key={f.name} className={`warn${f.triggered ? ' blocking' : ' info'}`}>
                  <span className="sev">{f.triggered ? 'Triggered' : 'Not triggered'} — {f.name}</span><br />
                  {f.description}<br /><span className="small">{f.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
