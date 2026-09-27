import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDynamicState, appendUpdate, isStale, evaluateStaleness,
  type DynamicConfig, type DynamicState,
} from '../dynamic.js';

const cfg: DynamicConfig = {
  oracleId: 'pyth-sim:SOL/USD',
  updateAuthority: 'UpdateAuth11111111111111111111111111111111',
  maxSupply: 1_000_000n,
  maxUpdateAgeSeconds: 300,
  minUpdateIntervalSeconds: 60,
  staleBehavior: 'freeze-transfers',
  valueToSupplyScale: 10n,
};

describe('oracle updates', () => {
  it('appends updates and adjusts supply, history is append-only', () => {
    let s = createDynamicState(cfg);
    s = appendUpdate(s, { value: 100n, timestamp: 1000, source: 'pyth-sim:SOL/USD' }, 1100);
    assert.equal(s.supply, 1000n);
    assert.equal(s.history.length, 1);
    s = appendUpdate(s, { value: 200n, timestamp: 1200, source: 'pyth-sim:SOL/USD' }, 1250);
    assert.equal(s.supply, 2000n);
    assert.equal(s.history.length, 2);
    assert.equal(s.history[0].value, 100n); // history untouched
  });

  it('clamps supply at maxSupply', () => {
    let s = createDynamicState(cfg);
    s = appendUpdate(s, { value: 500_000n, timestamp: 1000, source: 'x' }, 1100);
    assert.equal(s.supply, 1_000_000n);
  });

  it('rejects stale-at-arrival updates', () => {
    const s = createDynamicState(cfg);
    // update timestamp 1000s old at arrival -> older than maxUpdateAgeSeconds
    assert.throws(
      () => appendUpdate(s, { value: 1n, timestamp: 0, source: 'x' }, 10_000),
      /STALE_UPDATE/,
    );
  });

  it('rejects non-monotonic and too-frequent updates', () => {
    let s = createDynamicState(cfg);
    s = appendUpdate(s, { value: 1n, timestamp: 1000, source: 'x' }, 1100);
    assert.throws(() => appendUpdate(s, { value: 2n, timestamp: 1000, source: 'x' }, 1100), /NON_MONOTONIC_UPDATE/);
    assert.throws(() => appendUpdate(s, { value: 2n, timestamp: 1030, source: 'x' }, 1100), /TOO_FREQUENT/);
    assert.throws(() => appendUpdate(s, { value: 2n, timestamp: 2000, source: 'x' }, 1100), /FUTURE_UPDATE/);
  });
});

describe('staleness', () => {
  it('isStale true when no data or data aged out', () => {
    const s = createDynamicState(cfg);
    assert.equal(isStale(s, 1_000_000), true);
    const s2 = appendUpdate(s, { value: 1n, timestamp: 1000, source: 'x' }, 1100);
    assert.equal(isStale(s2, 1200), false);
    assert.equal(isStale(s2, 2000), true); // 1000s > 300s
  });

  it('evaluateStaleness reports freeze posture for holders', () => {
    const s0 = createDynamicState(cfg);
    const ev = evaluateStaleness(s0, 1_000_000);
    assert.equal(ev.stale, true);
    assert.equal(ev.transfersFrozen, true);
    assert.ok(ev.description.includes('frozen'));
  });
});
