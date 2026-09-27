import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceAt, canTransfer, canRedeem, decaySchedule, recipientOfRemovedValue,
  validateDecayConfig, periodsElapsed, decayScheduleSettled, type DecayConfig,
} from '../decay.js';

const cfg: DecayConfig = {
  expiresAt: 2_000_000_000,
  decayPeriodSeconds: 30 * 24 * 3600, // monthly
  decayRateBps: 500, // 5% per period
  removedValueRecipient: 'creator-treasury',
  transfersAllowedAfterExpiry: false,
  redemptionAllowedAfterExpiry: true,
};

describe('decay schedule', () => {
  it('balanceAt applies floored per-period decay', () => {
    // 1000 - floor(1000*5%) = 950 ; 950 - floor(950*5%)=950-47=903
    assert.equal(balanceAt(1000n, 0, 30 * 24 * 3600, cfg), 950n);
    assert.equal(balanceAt(1000n, 0, 2 * 30 * 24 * 3600, cfg), 903n);
  });

  it('no time elapsed means no decay', () => {
    assert.equal(balanceAt(1000n, 100, 100, cfg), 1000n);
  });

  it('removed value recipient is disclosed', () => {
    assert.ok(recipientOfRemovedValue(cfg).includes('creator treasury'));
  });

  it('decaySchedule rows sum removed + balance = starting balance', () => {
    const rows = decaySchedule(10_000n, 0, 6, cfg);
    assert.equal(rows.length, 6);
    const removed = rows.reduce((s, r) => s + r.removedThisPeriod, 0n);
    assert.equal(removed + rows[rows.length - 1].balance, 10_000n);
  });

  it('validation rejects bad configs', () => {
    assert.ok(validateDecayConfig({ ...cfg, decayRateBps: 10_001 }).length > 0);
    assert.ok(validateDecayConfig({ ...cfg, removedValueRecipient: '' }).length > 0);
  });
});

describe('decayScheduleSettled (on-chain parity with close_decay)', () => {
  // Mirrors the program's ScheduleNotSettled precondition:
  // floor((expiryTs - lastDecayTs) / periodSeconds) <= 0.
  // Security-review note: regression coverage from our own internal review,
  // not an independent audit.
  const PERIOD = 100;
  const EXPIRY = 1_010_000;

  it('settled when lastDecayTs == expiryTs', () => {
    assert.equal(decayScheduleSettled(EXPIRY, EXPIRY, PERIOD), true);
  });

  it('settled when less than one full period remains', () => {
    assert.equal(decayScheduleSettled(EXPIRY - 99, EXPIRY, PERIOD), true);
    assert.equal(decayScheduleSettled(EXPIRY - 1, EXPIRY, PERIOD), true);
  });

  it('not settled when one or more full periods remain', () => {
    assert.equal(decayScheduleSettled(EXPIRY - 100, EXPIRY, PERIOD), false);
    assert.equal(decayScheduleSettled(EXPIRY - 101, EXPIRY, PERIOD), false);
    assert.equal(decayScheduleSettled(EXPIRY - 10_000, EXPIRY, PERIOD), false);
  });

  it('settled when lastDecayTs is past expiryTs (defensive; crank caps at expiry)', () => {
    assert.equal(decayScheduleSettled(EXPIRY + 50, EXPIRY, PERIOD), true);
  });

  it('non-positive periodSeconds is never settled (rejected at init on-chain)', () => {
    assert.equal(decayScheduleSettled(EXPIRY, EXPIRY, 0), false);
    assert.equal(decayScheduleSettled(EXPIRY, EXPIRY, -5), false);
  });

  it('agrees with periodsElapsed at the expiry cap', () => {
    // settled  <=>  periodsElapsed(lastDecayTs, expiryTs, period, expiryTs) == 0
    // i.e. a crank at expiry would apply nothing (on-chain: DecayNotDue).
    for (const last of [EXPIRY - 10_000, EXPIRY - 100, EXPIRY - 99, EXPIRY, EXPIRY + 7]) {
      assert.equal(
        decayScheduleSettled(last, EXPIRY, PERIOD),
        periodsElapsed(last, EXPIRY, PERIOD, EXPIRY) === 0,
        `mismatch at lastDecayTs=${last}`,
      );
    }
  });
});

describe('expiry rules', () => {
  it('transfers blocked after expiry when configured', () => {
    assert.equal(canTransfer(cfg.expiresAt - 1, cfg).allowed, true);
    const after = canTransfer(cfg.expiresAt + 1, cfg);
    assert.equal(after.allowed, false);
    assert.ok(after.reason.includes('expired'));
  });

  it('redemption allowed after expiry when configured', () => {
    assert.equal(canRedeem(cfg.expiresAt + 1, cfg).allowed, true);
  });
});

describe('periodsElapsed (on-chain parity with apply_decay)', () => {
  // Mirrors: periods = floor((min(now, expiry) - lastDecay) / periodSeconds), clamped at 0.
  const LAST = 1_000_000;
  const PERIOD = 100;
  const EXPIRY = 1_010_000;

  it('now < lastDecayTs clamps to 0 (on-chain: DecayNotDue)', () => {
    assert.equal(periodsElapsed(LAST, LAST - 1, PERIOD, EXPIRY), 0);
    assert.equal(periodsElapsed(LAST, LAST - 10_000, PERIOD, EXPIRY), 0);
  });

  it('now == lastDecayTs yields 0', () => {
    assert.equal(periodsElapsed(LAST, LAST, PERIOD, EXPIRY), 0);
  });

  it('partial period yields 0; exact boundaries count fully', () => {
    assert.equal(periodsElapsed(LAST, LAST + 99, PERIOD, EXPIRY), 0);
    assert.equal(periodsElapsed(LAST, LAST + 100, PERIOD, EXPIRY), 1);
    assert.equal(periodsElapsed(LAST, LAST + 199, PERIOD, EXPIRY), 1);
    assert.equal(periodsElapsed(LAST, LAST + 200, PERIOD, EXPIRY), 2);
    assert.equal(periodsElapsed(LAST, LAST + 1000, PERIOD, EXPIRY), 10);
  });

  it('now > expiryTs is capped at expiryTs', () => {
    // (EXPIRY - LAST) / PERIOD = 10_000 / 100 = 100, no matter how far past expiry now is.
    assert.equal(periodsElapsed(LAST, EXPIRY + 1, PERIOD, EXPIRY), 100);
    assert.equal(periodsElapsed(LAST, EXPIRY + 1_000_000, PERIOD, EXPIRY), 100);
    // Expiry mid-period truncates: floor((1_009_950 - 1_000_000) / 100) = 99.
    assert.equal(periodsElapsed(LAST, EXPIRY + 500, PERIOD, EXPIRY - 50), 99);
  });

  it('expiry before lastDecayTs is a negative numerator, clamped to 0', () => {
    assert.equal(periodsElapsed(LAST, LAST + 50, PERIOD, LAST - 1), 0);
  });

  it('zero or negative periodSeconds returns 0 (rejected at init on-chain)', () => {
    assert.equal(periodsElapsed(LAST, LAST + 10_000, 0, EXPIRY), 0);
    assert.equal(periodsElapsed(LAST, LAST + 10_000, -5, EXPIRY), 0);
  });

  it('agrees with balanceAt period counting on sample points', () => {
    // balanceAt floors the same (toTime - fromTime) / periodSeconds when uncapped:
    // a partial 7-second tail adds no period, so both calls must agree.
    const p = periodsElapsed(0, 5 * cfg.decayPeriodSeconds + 7, cfg.decayPeriodSeconds, cfg.expiresAt);
    assert.equal(p, 5);
    assert.equal(
      balanceAt(1000n, 0, 5 * cfg.decayPeriodSeconds + 7, cfg),
      balanceAt(1000n, 0, 5 * cfg.decayPeriodSeconds, cfg),
    );
  });
});
