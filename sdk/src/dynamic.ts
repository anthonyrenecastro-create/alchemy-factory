/**
 * Oracle-fed update model for the `dynamic` mechanic.
 *
 * SIMULATION ONLY: pure functions, no chain state.
 *
 * Honesty rules enforced here:
 *  - An off-chain data source is NEVER described as decentralized merely
 *    because its result is written on-chain. `source` is a plain label of the
 *    off-chain origin (e.g. "pyth:SOL/USD").
 *  - Update history is APPEND-ONLY: `appendUpdate` returns a new state with the
 *    update pushed; nothing is ever edited or removed. The full change history
 *    is always available via `state.history`.
 *  - Staleness: an update is rejected if it is older than `maxUpdateAgeSeconds`
 *    at arrival, and `isStale(state, now)` reports when the last accepted
 *    update has aged past the threshold. What happens then is governed by
 *    `staleBehavior`, surfaced to holders verbatim.
 */

export interface OracleUpdate {
  /** New oracle value (fixed-point integer, interpretation defined by the experiment). */
  value: bigint;
  /** Unix seconds when the source produced this value. */
  timestamp: number;
  /** Off-chain origin label — informational only, NOT a decentralization claim. */
  source: string;
}

export type StaleBehavior = 'freeze-transfers' | 'use-last-value' | 'reject-new-updates';

export interface DynamicConfig {
  /** Identifier of the oracle feed / adapter. */
  oracleId: string;
  /** Base58 pubkey allowed to post updates, or null. */
  updateAuthority: string | null;
  /** Hard cap: supply target is clamped to this value. */
  maxSupply: bigint;
  /** Seconds after the last accepted update before data is considered stale. */
  maxUpdateAgeSeconds: number;
  /** Minimum seconds between accepted updates (anti-spam). */
  minUpdateIntervalSeconds: number;
  staleBehavior: StaleBehavior;
  /**
   * Supply target = min(value * valueToSupplyScale, maxSupply).
   * Interpretation of `value` is experiment-defined and shown to holders.
   */
  valueToSupplyScale: bigint;
}

export interface DynamicState {
  config: DynamicConfig;
  /** Append-only history of accepted updates, oldest first. */
  history: OracleUpdate[];
  /** Current supply in token base units. */
  supply: bigint;
}

export function createDynamicState(config: DynamicConfig): DynamicState {
  if (config.maxSupply <= 0n) throw new Error('MAX_SUPPLY_NON_POSITIVE');
  if (config.maxUpdateAgeSeconds <= 0) throw new Error('MAX_UPDATE_AGE_NON_POSITIVE');
  return { config, history: [], supply: 0n };
}

/** True when the last accepted update is older than `maxUpdateAgeSeconds`. */
export function isStale(state: DynamicState, now: number): boolean {
  const last = state.history[state.history.length - 1];
  if (!last) return true; // no data at all counts as stale
  return now - last.timestamp > state.config.maxUpdateAgeSeconds;
}

/** Seconds since the last accepted update (Infinity when none). */
export function lastUpdateAge(state: DynamicState, now: number): number {
  const last = state.history[state.history.length - 1];
  if (!last) return Number.POSITIVE_INFINITY;
  return now - last.timestamp;
}

export interface SupplyAdjustment {
  oldSupply: bigint;
  newSupply: bigint;
  delta: bigint;
  /** True when the target exceeded maxSupply and was clamped. */
  clamped: boolean;
}

/**
 * Accept an oracle update. Throws on:
 *  - STALE_UPDATE: the update's own timestamp is older than maxUpdateAgeSeconds
 *    at arrival (stale data is never written).
 *  - NON_MONOTONIC_UPDATE: timestamp not strictly after the last accepted one.
 *  - TOO_FREQUENT: sooner than minUpdateIntervalSeconds after the last update.
 *  - FUTURE_UPDATE: timestamp is in the future.
 */
export function appendUpdate(state: DynamicState, update: OracleUpdate, now: number): DynamicState {
  const cfg = state.config;
  if (update.timestamp > now) throw new Error('FUTURE_UPDATE');
  if (now - update.timestamp > cfg.maxUpdateAgeSeconds) throw new Error('STALE_UPDATE');
  const last = state.history[state.history.length - 1];
  if (last) {
    if (update.timestamp <= last.timestamp) throw new Error('NON_MONOTONIC_UPDATE');
    if (update.timestamp - last.timestamp < cfg.minUpdateIntervalSeconds) throw new Error('TOO_FREQUENT');
  }
  const target = update.value * cfg.valueToSupplyScale;
  const newSupply = target > cfg.maxSupply ? cfg.maxSupply : target;
  return {
    config: cfg,
    history: [...state.history, update],
    supply: newSupply,
  };
}

/** What the token does when oracle data is stale — surfaced verbatim to holders. */
export function staleBehaviorDescription(behavior: StaleBehavior): string {
  switch (behavior) {
    case 'freeze-transfers':
      return 'If oracle data goes stale, transfers are frozen until a fresh update arrives.';
    case 'use-last-value':
      return 'If oracle data goes stale, the token keeps using the last accepted value.';
    case 'reject-new-updates':
      return 'If oracle data goes stale, new updates are rejected until the feed recovers.';
  }
}

/** Evaluate the current staleness posture for display in the holder app. */
export function evaluateStaleness(state: DynamicState, now: number): {
  stale: boolean;
  lastUpdateAgeSeconds: number;
  transfersFrozen: boolean;
  description: string;
} {
  const stale = isStale(state, now);
  return {
    stale,
    lastUpdateAgeSeconds: lastUpdateAge(state, now),
    transfersFrozen: stale && state.config.staleBehavior === 'freeze-transfers',
    description: staleBehaviorDescription(state.config.staleBehavior),
  };
}

/**
 * On-chain acceptance mirror for `alchemy_dynamic::ingest_update`
 * (programs/programs/alchemy_dynamic/src/lib.rs).
 *
 * The on-chain program enforces the SAME freshness / monotonicity / frequency
 * checks as `appendUpdate`, in the SAME order. Two rules have no SDK twin and
 * are documented here as deliberate divergences:
 *  - `paused`: an on-chain-only admin circuit breaker, checked FIRST.
 *  - `value <= maxSupply` is a HARD REJECT on-chain; `appendUpdate` instead
 *    clamps the simulated supply target, because `valueToSupplyScale` has no
 *    on-chain counterpart (`value` semantics are experiment-defined).
 *
 * Returns the rejection reason, or null when the update would be accepted.
 */
export interface OnChainDynamicMirror {
  maxSupply: bigint;
  updateFrequencySeconds: number;
  staleThresholdSeconds: number;
  updateCount: number;
  /** source_ts of the last accepted update (0 when none). */
  lastUpdateTs: number;
  paused: boolean;
}

export type OnChainRejectReason =
  | 'PAUSED'
  | 'FUTURE_UPDATE'
  | 'STALE_UPDATE'
  | 'NON_MONOTONIC_UPDATE'
  | 'TOO_FREQUENT'
  | 'MAX_SUPPLY_EXCEEDED';

export function checkOnChainAccept(
  cfg: OnChainDynamicMirror,
  value: bigint,
  sourceTs: number,
  now: number,
): OnChainRejectReason | null {
  if (cfg.paused) return 'PAUSED';
  if (sourceTs > now) return 'FUTURE_UPDATE';
  if (now - sourceTs > cfg.staleThresholdSeconds) return 'STALE_UPDATE';
  if (cfg.updateCount > 0) {
    if (sourceTs <= cfg.lastUpdateTs) return 'NON_MONOTONIC_UPDATE';
    if (sourceTs - cfg.lastUpdateTs < cfg.updateFrequencySeconds) return 'TOO_FREQUENT';
  }
  if (value > cfg.maxSupply) return 'MAX_SUPPLY_EXCEEDED';
  return null;
}
