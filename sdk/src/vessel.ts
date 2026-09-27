/**
 * Container model for the `vessel` (hierarchical & nested) mechanic.
 *
 * SIMULATION ONLY: pure functions, no chain state.
 *
 * A vessel is a transferable container over a defined set of assets:
 *  - `holdings` is the actual asset ledger (mint -> amount).
 *  - `custodyProgram` names the on-chain program holding the assets.
 *  - Deposits/withdrawals are gated by permission checks.
 *  - `transferOwnership` moves the container to a new owner: the FULL holdings
 *    ledger, the permission config, and the authority set transfer with it;
 *    the custody program does NOT change (assets stay where they are).
 */

export interface VesselHolding {
  /** Mint address (base58) of the held asset. */
  mint: string;
  amount: bigint;
}

export type VesselPermission = 'open' | 'owner-only' | 'authority-list';

export interface VesselConfig {
  /** Program that custodies the underlying assets (informational in simulation). */
  custodyProgram: string;
  depositPermission: VesselPermission;
  withdrawPermission: VesselPermission;
  authorizedDepositors: string[];
  authorizedWithdrawers: string[];
}

export interface VesselState {
  config: VesselConfig;
  /** Base58 pubkey of the current container owner. */
  owner: string;
  holdings: VesselHolding[];
}

export function createVesselState(config: VesselConfig, owner: string): VesselState {
  return { config, owner, holdings: [] };
}

function permitted(permission: VesselPermission, caller: string, owner: string, list: string[]): boolean {
  switch (permission) {
    case 'open':
      return true;
    case 'owner-only':
      return caller === owner;
    case 'authority-list':
      return list.includes(caller);
  }
}

export function canDeposit(state: VesselState, caller: string): { allowed: boolean; reason: string } {
  const ok = permitted(state.config.depositPermission, caller, state.owner, state.config.authorizedDepositors);
  return ok
    ? { allowed: true, reason: 'Caller may deposit into the vessel.' }
    : { allowed: false, reason: `Deposit permission is '${state.config.depositPermission}' and this caller is not authorized.` };
}

export function canWithdraw(state: VesselState, caller: string): { allowed: boolean; reason: string } {
  const ok = permitted(state.config.withdrawPermission, caller, state.owner, state.config.authorizedWithdrawers);
  return ok
    ? { allowed: true, reason: 'Caller may withdraw from the vessel.' }
    : { allowed: false, reason: `Withdraw permission is '${state.config.withdrawPermission}' and this caller is not authorized.` };
}

export function holdingOf(state: VesselState, mint: string): bigint {
  return state.holdings.find((h) => h.mint === mint)?.amount ?? 0n;
}

export function deposit(state: VesselState, caller: string, mint: string, amount: bigint): VesselState {
  if (amount <= 0n) throw new Error('DEPOSIT_AMOUNT_NON_POSITIVE');
  const check = canDeposit(state, caller);
  if (!check.allowed) throw new Error(`DEPOSIT_NOT_PERMITTED: ${check.reason}`);
  const holdings = state.holdings.map((h) =>
    h.mint === mint ? { ...h, amount: h.amount + amount } : h,
  );
  if (!holdings.some((h) => h.mint === mint)) holdings.push({ mint, amount });
  return { ...state, holdings };
}

export function withdraw(state: VesselState, caller: string, mint: string, amount: bigint): VesselState {
  if (amount <= 0n) throw new Error('WITHDRAW_AMOUNT_NON_POSITIVE');
  const check = canWithdraw(state, caller);
  if (!check.allowed) throw new Error(`WITHDRAW_NOT_PERMITTED: ${check.reason}`);
  const current = holdingOf(state, mint);
  if (current < amount) throw new Error('INSUFFICIENT_VESSEL_BALANCE');
  const holdings = state.holdings
    .map((h) => (h.mint === mint ? { ...h, amount: h.amount - amount } : h))
    .filter((h) => h.amount > 0n);
  return { ...state, holdings };
}

export interface OwnershipTransferSummary {
  previousOwner: string;
  newOwner: string;
  /** Every holding that moves with the container. */
  transferredHoldings: VesselHolding[];
  /** Permission rules that move with the container. */
  transferredPermissions: string[];
  /** Always empty: nothing stays with the previous owner. */
  retainedByPreviousOwner: string[];
  custodyProgramUnchanged: string;
}

/**
 * Transfer container ownership. The previous owner retains NOTHING:
 * holdings, permissions, and authority move to the new owner; the custody
 * program (where assets physically sit) is unchanged.
 */
export function transferOwnership(
  state: VesselState,
  newOwner: string,
): { state: VesselState; summary: OwnershipTransferSummary } {
  if (!newOwner) throw new Error('NEW_OWNER_REQUIRED');
  const summary: OwnershipTransferSummary = {
    previousOwner: state.owner,
    newOwner,
    transferredHoldings: state.holdings.map((h) => ({ ...h })),
    transferredPermissions: [
      `deposit: ${state.config.depositPermission}`,
      `withdraw: ${state.config.withdrawPermission}`,
    ],
    retainedByPreviousOwner: [],
    custodyProgramUnchanged: state.config.custodyProgram,
  };
  return { state: { ...state, owner: newOwner }, summary };
}
