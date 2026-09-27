import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  balanceAt, canTransfer, canRedeem, decaySchedule, recipientOfRemovedValue,
  validateDecayConfig, type DecayConfig,
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
