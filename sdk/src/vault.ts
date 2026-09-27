/**
 * Vault (PAXG collateral module) simulation for Stage 3.
 *
 * SIMULATION ONLY: pure functions, no chain state. These formulas MIRROR the
 * on-chain `alchemy_vault` program in `programs/alchemy_vault/src/lib.rs`
 * EXACTLY — same parametrization, same integer arithmetic, same rounding,
 * same error names (ZeroAmount, WithdrawalLimitExceeded, InvalidBps, ...
 * matching VaultError). If the program changes, this file must change with it.
 *
 * The on-chain state (VaultConfig.total_collateral / total_shares) is a
 * classic ERC-4626-style share vault: depositors mint shares pro-rata to
 * collateral, redeemers burn shares for pro-rata collateral minus fees.
 *
 * BINDING ROUNDING RULE (identical on-chain):
 *  - All amounts are integers (bigint); every division truncates toward zero
 *    unless stated otherwise.
 *  - DEPOSITS floor: the new depositor's share mint rounds DOWN. This protects
 *    existing holders: any remainder stays in the vault, slightly raising the
 *    share price for everyone else, and a dust deposit that would mint zero
 *    shares is rejected (shares === 0n -> ZeroAmount) instead of being
 *    absorbed for nothing.
 *  - REDEEMS floor: the gross collateral for burned shares rounds DOWN. This
 *    protects vault solvency: the vault can never pay out more collateral
 *    than the shares are worth, so total_collateral >= implied claims holds
 *    after every operation.
 *  - FEES ceil: the redemption fee rounds UP. This protects the treasury and
 *    the remaining holders: the fee can never underflow to zero when a
 *    nonzero rate applies, so value never leaks from the fee pipeline.
 *  - The withdrawal limit itself floors (conservative: the allowed amount is
 *    never rounded up past the limit).
 *
 * Repo-wide convention (see curve.ts): value leaving the reserve/protocal
 * rounds in the reserve's favor (floor), value extracted as fees rounds in
 * the protocol's favor (ceil).
 *
 * Units: collateral and shares are both in base units of their respective
 * mints (u64 on-chain). Intermediate math is u128 on-chain; here bigint is
 * unbounded, so results are explicitly range-checked to fit u64 (MathOverflow
 * semantics) before being returned.
 */

/** On-chain u64::MAX. Used as range bound and as the "infinite ratio" sentinel. */
export const U64_MAX = 2n ** 64n - 1n;

const BPS_DENOMINATOR = 10_000n;

export interface VaultState {
  /** Total collateral units held by the vault (on-chain `total_collateral`). */
  totalCollateral: bigint;
  /** Total outstanding shares (on-chain `total_shares`). */
  totalShares: bigint;
  /** Max fraction of the vault withdrawable per redemption, in bps. */
  withdrawalLimitBps: number;
  /** Redemption fee in basis points (100 bps = 1%). */
  redeemFeeBps: number;
}

/**
 * Validate a vault's fee/limit configuration.
 * Throws Error('InvalidBps') if either value exceeds 10000 bps, mirroring
 * on-chain `VaultError::InvalidBps` (u16 field, hard cap at 100%).
 */
export function validateVaultConfig(withdrawalLimitBps: number, redeemFeeBps: number): void {
  if (!Number.isInteger(withdrawalLimitBps) || withdrawalLimitBps < 0 || withdrawalLimitBps > 10_000) {
    throw new Error('InvalidBps');
  }
  if (!Number.isInteger(redeemFeeBps) || redeemFeeBps < 0 || redeemFeeBps > 10_000) {
    throw new Error('InvalidBps');
  }
}

/** Assert a value fits in on-chain u64. Mirrors checked_cast::<u64> / MathOverflow. */
function checkedU64(value: bigint): bigint {
  if (value < 0n || value > U64_MAX) throw new Error('MathOverflow');
  return value;
}

export interface DepositResult {
  /** Shares minted to the depositor (floored). */
  shares: bigint;
  newState: VaultState;
}

/**
 * Simulate a collateral deposit. Mirrors on-chain `deposit_collateral`.
 *
 * First depositor mints 1:1 (amount == shares). Later depositors mint
 * pro-rata: shares = floor(amount * totalShares / totalCollateral).
 * A deposit that would mint zero shares is rejected as ZeroAmount (dust).
 */
export function simulateDeposit(state: VaultState, amount: bigint): DepositResult {
  if (amount <= 0n) throw new Error('ZeroAmount');
  const shares =
    state.totalShares === 0n
      ? amount
      : (amount * state.totalShares) / state.totalCollateral;
  // Dust deposits (floored to zero shares) are rejected outright so the
  // depositor's collateral is never absorbed without representation.
  if (shares === 0n) throw new Error('ZeroAmount');
  checkedU64(shares);
  const newState: VaultState = {
    ...state,
    totalCollateral: checkedU64(state.totalCollateral + amount),
    totalShares: checkedU64(state.totalShares + shares),
  };
  return { shares, newState };
}

export interface RedeemResult {
  /** Collateral before fees (floored pro-rata of burned shares). */
  gross: bigint;
  /** Redemption fee (rounded UP). */
  fee: bigint;
  /** Collateral the redeemer actually receives: gross - fee. */
  net: bigint;
  newState: VaultState;
}

/**
 * Simulate a share redemption. Mirrors on-chain `redeem_shares`.
 *
 * gross = floor(shares * totalCollateral / totalShares), limited to the per-
 * redemption withdrawal cap: gross must not exceed
 * floor(totalCollateral * withdrawalLimitBps / 10000) else
 * WithdrawalLimitExceeded. fee = ceil(gross * redeemFeeBps / 10000);
 * net = gross - fee.
 */
export function simulateRedeem(state: VaultState, shares: bigint): RedeemResult {
  if (shares <= 0n) throw new Error('ZeroAmount');
  if (shares > state.totalShares) throw new Error('InsufficientShares');
  const gross = (shares * state.totalCollateral) / state.totalShares;
  if (gross === 0n) throw new Error('ZeroAmount');
  // The limit floors, so the cap is never rounded up past the configured bps.
  const limit = withdrawalLimitAmount(state);
  if (gross > limit) throw new Error('WithdrawalLimitExceeded');
  checkedU64(gross);
  const fee = checkedU64((gross * BigInt(state.redeemFeeBps) + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR);
  const net = checkedU64(gross - fee);
  const newState: VaultState = {
    ...state,
    totalCollateral: checkedU64(state.totalCollateral - gross),
    totalShares: checkedU64(state.totalShares - shares),
  };
  return { gross, fee, net, newState };
}

/**
 * Per-redemption withdrawal cap in collateral units (floored).
 * Mirrors the on-chain limit check in `redeem_shares`.
 */
export function withdrawalLimitAmount(state: VaultState): bigint {
  return (state.totalCollateral * BigInt(state.withdrawalLimitBps)) / BPS_DENOMINATOR;
}

/**
 * Collateral ratio in basis points: floor(balance * 10000 / claims).
 * Returns u64::MAX when there are no outstanding claims, mirroring
 * on-chain `collateral_ratio_bps` for the VaultProof snapshot.
 */
export function collateralRatioBps(balance: bigint, claims: bigint): bigint {
  if (claims === 0n) return U64_MAX;
  return (balance * BPS_DENOMINATOR) / claims;
}
