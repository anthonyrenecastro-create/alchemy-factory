/**
 * Time-decay math for the `decay` mechanic.
 *
 * SIMULATION ONLY: pure functions, no chain state.
 *
 * Two SEPARATELY specified sub-models:
 *  1. Fixed expiration — a timestamp after which transfers/redemption may be
 *     disabled per config.
 *  2. Periodic decay schedule — every `decayPeriodSeconds`, each balance is
 *     reduced by `decayRateBps` (applied to the CURRENT balance, floored).
 *
 * Removed value goes to `removedValueRecipient` — the simulation shows exactly
 * who receives it; it is never silently burned or kept by the protocol.
 */

export interface DecayConfig {
  /** Unix seconds at which the token expires. */
  expiresAt: number;
  /** Seconds between decay applications. */
  decayPeriodSeconds: number;
  /** Basis points removed from each balance per period (0..10000). */
  decayRateBps: number;
  /** Who receives removed value: 'creator-treasury' or a base58 address. */
  removedValueRecipient: string;
  /** Whether plain transfers are allowed after expiry. */
  transfersAllowedAfterExpiry: boolean;
  /** Whether redemption (if any) is allowed after expiry. */
  redemptionAllowedAfterExpiry: boolean;
}

export function validateDecayConfig(config: DecayConfig): string[] {
  const errors: string[] = [];
  if (config.decayPeriodSeconds <= 0) errors.push('decayPeriodSeconds must be > 0');
  if (!Number.isInteger(config.decayRateBps) || config.decayRateBps < 0 || config.decayRateBps > 10_000) {
    errors.push('decayRateBps must be an integer between 0 and 10000');
  }
  if (config.decayRateBps === 10_000) errors.push('decayRateBps of 10000 wipes balances every period — likely a misconfiguration');
  if (!config.removedValueRecipient) errors.push('removedValueRecipient must name who receives removed value');
  return errors;
}

/** Balance after decay from `fromTime` to `toTime` (unix seconds). Floored per period. */
export function balanceAt(
  balance: bigint,
  fromTime: number,
  toTime: number,
  config: DecayConfig,
): bigint {
  if (toTime <= fromTime) return balance;
  const periods = Math.floor((toTime - fromTime) / config.decayPeriodSeconds);
  let b = balance;
  for (let i = 0; i < periods; i++) {
    const removed = (b * BigInt(config.decayRateBps)) / 10_000n; // floored
    b -= removed;
    if (b === 0n) break;
  }
  return b;
}

export function isExpired(now: number, config: DecayConfig): boolean {
  return now >= config.expiresAt;
}

/**
 * On-chain parity: mirrors `apply_decay`'s period counting in the
 * `alchemy_decay` program EXACTLY.
 *
 * periods = floor((min(nowTs, expiryTs) - lastDecayTs) / periodSeconds),
 * clamped at 0 when the numerator is negative.
 *
 * On-chain, a result of 0 (or negative elapsed) fails with `DecayNotDue`;
 * this function returns the raw count so callers can distinguish
 * "not due" (0) from "due" (>= 1).
 *
 * `periodSeconds <= 0` can never reach the program (rejected at init), so it
 * returns 0 here as a simulation-side guard.
 */
export function periodsElapsed(
  lastDecayTs: number,
  nowTs: number,
  periodSeconds: number,
  expiryTs: number,
): number {
  if (periodSeconds <= 0) return 0;
  const effective = Math.min(nowTs, expiryTs);
  const elapsed = effective - lastDecayTs;
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / periodSeconds);
}

/**
 * On-chain parity with the `alchemy_decay::close_decay` settlement
 * precondition.
 *
 * The program refuses to close a decay config while any full decay period
 * between `lastDecayTs` and `expiryTs` remains unapplied (`ScheduleNotSettled`):
 * the authority must crank the tail first, so closing cannot truncate the
 * on-chain schedule record (`total_periods_applied`).
 *
 * Mirrors: floor((expiryTs - lastDecayTs) / periodSeconds) <= 0.
 * Integrators (e.g. the holder app) can call this before attempting a close
 * to know whether a final crank is still required.
 */
export function decayScheduleSettled(
  lastDecayTs: number,
  expiryTs: number,
  periodSeconds: number,
): boolean {
  if (periodSeconds <= 0) return false;
  return Math.floor((expiryTs - lastDecayTs) / periodSeconds) <= 0;
}

export function canTransfer(now: number, config: DecayConfig): { allowed: boolean; reason: string } {  if (!isExpired(now, config)) return { allowed: true, reason: 'Token has not expired.' };
  return config.transfersAllowedAfterExpiry
    ? { allowed: true, reason: 'Expiry passed, but this token permits transfers after expiry.' }
    : { allowed: false, reason: 'Token expired: transfers are disabled by the experiment config.' };
}

export function canRedeem(now: number, config: DecayConfig): { allowed: boolean; reason: string } {
  if (!isExpired(now, config)) return { allowed: true, reason: 'Token has not expired.' };
  return config.redemptionAllowedAfterExpiry
    ? { allowed: true, reason: 'Expiry passed, but redemption remains available.' }
    : { allowed: false, reason: 'Token expired: redemption is disabled by the experiment config.' };
}

/** Plain-English statement of who receives removed value. */
export function recipientOfRemovedValue(config: DecayConfig): string {
  return config.removedValueRecipient === 'creator-treasury'
    ? 'Removed value accrues to the creator treasury (it is NOT burned).'
    : `Removed value is transferred to ${config.removedValueRecipient}.`;
}

export interface DecayPeriodRow {
  period: number;
  time: number;
  balance: bigint;
  removedThisPeriod: bigint;
  recipient: string;
}

/** Simulate `periods` decay applications starting at `startTime`. */
export function decaySchedule(
  balance: bigint,
  startTime: number,
  periods: number,
  config: DecayConfig,
): DecayPeriodRow[] {
  const rows: DecayPeriodRow[] = [];
  let b = balance;
  for (let p = 1; p <= periods; p++) {
    const removed = (b * BigInt(config.decayRateBps)) / 10_000n;
    b -= removed;
    rows.push({
      period: p,
      time: startTime + p * config.decayPeriodSeconds,
      balance: b,
      removedThisPeriod: removed,
      recipient: config.removedValueRecipient,
    });
    if (b === 0n) break;
  }
  return rows;
}
