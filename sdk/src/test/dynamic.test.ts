import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDynamicState, appendUpdate, isStale, evaluateStaleness,
  checkOnChainAccept,
  type DynamicConfig, type DynamicState,
  type OnChainDynamicMirror, type OnChainRejectReason,
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

describe('on-chain parity (checkOnChainAccept vs appendUpdate)', () => {
  const toMirror = (s: DynamicState, paused = false): OnChainDynamicMirror => ({
    maxSupply: s.config.maxSupply,
    updateFrequencySeconds: s.config.minUpdateIntervalSeconds,
    staleThresholdSeconds: s.config.maxUpdateAgeSeconds,
    updateCount: s.history.length,
    lastUpdateTs: s.history.length > 0 ? s.history[s.history.length - 1].timestamp : 0,
    paused,
  });

  const fresh = () => createDynamicState(cfg);
  // One accepted update at ts=1000 (arrived at now=1100): the base state for
  // the monotonicity / frequency cases.
  const withOne = () =>
    appendUpdate(fresh(), { value: 1n, timestamp: 1000, source: 'x' }, 1100);

  interface ParityCase {
    name: string;
    base: () => DynamicState;
    update: { value: bigint; timestamp: number; source: string };
    now: number;
    /** Expected appendUpdate outcome: null = accepts, else the thrown code. */
    sdkThrows: RegExp | null;
    /** Expected checkOnChainAccept outcome (null = accepted). */
    mirror: OnChainRejectReason | null;
  }

  const cases: ParityCase[] = [
    {
      name: 'fresh update accepted by both',
      base: withOne,
      update: { value: 5n, timestamp: 1200, source: 'x' },
      now: 1250,
      sdkThrows: null,
      mirror: null,
    },
    {
      name: 'gap exactly at the frequency boundary is accepted',
      base: withOne,
      update: { value: 5n, timestamp: 1060, source: 'x' }, // gap 60 == minUpdateIntervalSeconds
      now: 1100,
      sdkThrows: null,
      mirror: null,
    },
    {
      name: 'age exactly at the staleness boundary is accepted',
      base: fresh,
      update: { value: 1n, timestamp: 700, source: 'x' }, // age 300 == maxUpdateAgeSeconds
      now: 1000,
      sdkThrows: null,
      mirror: null,
    },
    {
      name: 'stale-at-arrival rejected by both',
      base: fresh,
      update: { value: 1n, timestamp: 699, source: 'x' },
      now: 1000,
      sdkThrows: /STALE_UPDATE/,
      mirror: 'STALE_UPDATE',
    },
    {
      name: 'future timestamp rejected by both',
      base: fresh,
      update: { value: 1n, timestamp: 1001, source: 'x' },
      now: 1000,
      sdkThrows: /FUTURE_UPDATE/,
      mirror: 'FUTURE_UPDATE',
    },
    {
      name: 'equal timestamp rejected as non-monotonic by both',
      base: withOne,
      update: { value: 2n, timestamp: 1000, source: 'x' },
      now: 1100,
      sdkThrows: /NON_MONOTONIC_UPDATE/,
      mirror: 'NON_MONOTONIC_UPDATE',
    },
    {
      name: 'earlier timestamp rejected as non-monotonic by both',
      base: withOne,
      update: { value: 2n, timestamp: 999, source: 'x' },
      now: 1100,
      sdkThrows: /NON_MONOTONIC_UPDATE/,
      mirror: 'NON_MONOTONIC_UPDATE',
    },
    {
      name: 'too-frequent update rejected by both',
      base: withOne,
      update: { value: 2n, timestamp: 1059, source: 'x' }, // gap 59 < 60
      now: 1100,
      sdkThrows: /TOO_FREQUENT/,
      mirror: 'TOO_FREQUENT',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const s = c.base();
      assert.equal(
        checkOnChainAccept(toMirror(s), c.update.value, c.update.timestamp, c.now),
        c.mirror,
        'mirror decision',
      );
      if (c.sdkThrows) {
        assert.throws(() => appendUpdate(s, c.update, c.now), c.sdkThrows);
      } else {
        assert.doesNotThrow(() => appendUpdate(s, c.update, c.now));
      }
    });
  }

  it('over-max-supply: SDK clamps, on-chain rejects (documented divergence)', () => {
    const s = withOne();
    // The simulation clamps the supply target instead of rejecting
    // (valueToSupplyScale has no on-chain twin): target = 1_000_001 * 10.
    const clamped = appendUpdate(s, { value: 1_000_001n, timestamp: 1200, source: 'x' }, 1250);
    assert.equal(clamped.supply, 1_000_000n);
    // The on-chain program hard-rejects value > max_supply.
    assert.equal(
      checkOnChainAccept(toMirror(s), 1_000_001n, 1200, 1250),
      'MAX_SUPPLY_EXCEEDED',
    );
  });

  it('paused: on-chain-only circuit breaker (no SDK twin)', () => {
    const s = withOne();
    // appendUpdate has no pause concept: it still accepts.
    assert.doesNotThrow(() =>
      appendUpdate(s, { value: 5n, timestamp: 1200, source: 'x' }, 1250),
    );
    // The on-chain program rejects everything while paused.
    assert.equal(
      checkOnChainAccept(toMirror(s, true), 5n, 1200, 1250),
      'PAUSED',
    );
    assert.equal(checkOnChainAccept(toMirror(s, false), 5n, 1200, 1250), null);
  });
});
