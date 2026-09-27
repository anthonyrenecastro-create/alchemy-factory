import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulateJubileeSim, holderOutcomeSim, insolvencyCheckSim, jubileeFailureCasesSim,
  JUBILEE_MONTHLY_REDUCTION_BPS_SIM,
} from '../jubilee.js';

const params = {
  initialCollateralMockGoldSim: 1_000_000_000n, // 1e9 mock-gold base units
  initialSupplySim: 1_000_000n, // 1e6 tokens -> 1000 mock-gold per token at month 0
  monthsSim: 12,
};

describe('jubilee simulation', () => {
  it('applies the disclosed 1%/month rule with exact floored arithmetic', () => {
    assert.equal(JUBILEE_MONTHLY_REDUCTION_BPS_SIM, 100);
    const s = simulateJubileeSim(params);
    assert.equal(s.months.length, 12);
    // month 1: floor(1000 * 9900/10000) = floor(990) = 990 (1% of 1000 = 10)
    assert.equal(s.months[0].claimPerTokenSim, 990n);
    // month 2: floor(990 * 9900/10000) = floor(980.1) = 980
    assert.equal(s.months[1].claimPerTokenSim, 980n);
    assert.ok(s.months[11].claimPerTokenSim < s.months[0].claimPerTokenSim);
  });

  it('treasury cumulative equals the sum of monthly sweeps (nothing lost)', () => {
    const s = simulateJubileeSim(params);
    const sum = s.months.reduce((a, m) => a + m.treasurySweptSim, 0n);
    assert.equal(sum, s.totalSweptSim);
    // conservation: final claims + treasury = initial collateral
    const last = s.months[11];
    assert.equal(last.totalClaimsSim + last.treasuryCumulativeSim, params.initialCollateralMockGoldSim);
    assert.equal(last.collateralRemainingSim, last.totalClaimsSim);
  });

  it('holder outcomes: claimable shrinks, removed amount is exact', () => {
    const s = simulateJubileeSim(params);
    const out = holderOutcomeSim(s, params.initialCollateralMockGoldSim, params.initialSupplySim, 100n, 12);
    assert.equal(out.claimableAtMonth0Sim, 100_000n);
    assert.ok(out.claimableSim < out.claimableAtMonth0Sim);
    assert.equal(out.removedFromHolderSim, out.claimableAtMonth0Sim - out.claimableSim);
  });

  it('insolvency guard: collateral below claims is insolvent with exact shortfall', () => {
    const ok = insolvencyCheckSim(1_000_000n, 900_000n);
    assert.equal(ok.solvent, true);
    assert.equal(ok.shortfall, 0n);
    const bad = insolvencyCheckSim(800_000n, 900_000n);
    assert.equal(bad.solvent, false);
    assert.equal(bad.shortfall, 100_000n);
  });

  it('failure cases: shortfall triggers, missed sweep is reported', () => {
    const s = simulateJubileeSim(params);
    const last = s.months[11];
    const cases = jubileeFailureCasesSim(s, last.totalClaimsSim - 1n, [3]);
    const shortfall = cases.find((c) => c.name === 'collateral-shortfall')!;
    assert.equal(shortfall.triggered, true);
    assert.ok(shortfall.detail.includes('Shortfall'));
    const missed = cases.find((c) => c.name === 'missed-treasury-sweep-month-3')!;
    assert.equal(missed.triggered, true);
    assert.ok(missed.detail.includes(s.treasuryName));
  });

  it('rejects invalid parameters', () => {
    assert.throws(() => simulateJubileeSim({ ...params, initialCollateralMockGoldSim: 0n }), /NON_POSITIVE/);
    assert.throws(() => simulateJubileeSim({ ...params, monthsSim: 0 }), /INVALID/);
  });
});
