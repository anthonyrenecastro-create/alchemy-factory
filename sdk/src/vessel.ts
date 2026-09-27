/**
 * Container model for the `vessel` (hierarchical & nested) mechanic.
 *
 * SIMULATION ONLY: pure functions, no chain state.
 *
 * Mirrors the on-chain `alchemy_vessel` custody model (v1):
 *  - The vessel PDA itself custodies the assets. Each (vessel, asset mint)
 *    has a PDA-owned Token-2022 token account ("custody account") whose
 *    authority is the vessel PDA. `custodyProgram` is pinned to the
 *    Token-2022 program ID on-chain and disclosed to holders verbatim.
 *  - `holdings` mirrors the on-chain `VesselHolding` PDAs: one entry per
 *    asset mint with `amount` (the recorded ledger) and `custodyBalance`
 *    (the custody token account's actual balance). The program asserts
 *    `amount == custodyBalance` after every deposit/withdrawal
 *    (`HoldingMismatch` otherwise), and this simulation enforces the same
 *    invariant.
 *  - Permissions are two fixed roles, not a permission ladder:
 *    `depositAuthority` is the only key that may deposit,
 *    `withdrawAuthority` the only key that may withdraw. They may be the
 *    same key or different keys, and may coincide with the owner.
 *  - `transferOwnership` moves the container to a new owner: every holding
 *    record, the authority config, and the asset count move with it; the
 *    assets themselves never move and the custody program is unchanged.
 *    Ownership transfer does NOT rotate the deposit/withdraw authorities.
 *  - Zero-balance holdings are kept (never closed), so `assetCount` counts
 *    distinct asset mints ever registered — matching on-chain behavior.
 */

export interface VesselHolding {
  /** Mint address (base58) of the held asset. */
  mint: string;
  /** Ledger amount recorded in the VesselHolding PDA. */
  amount: bigint;
  /** Actual balance of the PDA-owned custody token account. */
  custodyBalance: bigint;
}

export interface VesselConfig {
  /**
   * Token program that physically holds the assets, disclosed verbatim.
   * Pinned to the Token-2022 program ID on-chain in v1.
   */
  custodyProgram: string;
  /** The single key authorized to deposit assets into the vessel. */
  depositAuthority: string;
  /** The single key authorized to withdraw assets from the vessel. */
  withdrawAuthority: string;
}

export interface VesselState {
  config: VesselConfig;
  /** Base58 pubkey of the current container owner. */
  owner: string;
  /** One entry per asset mint; zero-balance entries are kept, never closed. */
  holdings: VesselHolding[];
  /** Distinct asset mints ever registered (mirrors on-chain asset_count). */
  assetCount: number;
}

/**
 * Token-2022 mint extensions the vessel accepts on custodied asset mints.
 * Mirrors the on-chain allow-list enforced by `deposit_asset` (internal
 * security review 2026-09-27 — our own review, not an external audit).
 * Everything else — PermanentDelegate, TransferHook, TransferFeeConfig,
 * NonTransferable, DefaultAccountState, the confidential suite, and the rest
 * — is rejected on-chain with `InvalidAssetMint`.
 */
export const ALLOWED_ASSET_MINT_EXTENSIONS: readonly string[] = [
  'MetadataPointer',
  'TokenMetadata',
  'MintCloseAuthority',
];

/**
 * Reject a mint carrying any extension outside the allow-list. Throws
 * INVALID_ASSET_MINT naming the offending extension — the simulation
 * equivalent of on-chain `deposit_asset`'s extension gate.
 */
export function assertAllowedAssetMintExtensions(extensionNames: string[]): void {
  for (const name of extensionNames) {
    if (!ALLOWED_ASSET_MINT_EXTENSIONS.includes(name)) {
      throw new Error(`INVALID_ASSET_MINT: extension '${name}' is not accepted for vessel custody`);
    }
  }
}

export function createVesselState(config: VesselConfig, owner: string): VesselState {
  if (!config.custodyProgram) throw new Error('INVALID_CUSTODY_PROGRAM');
  if (!config.depositAuthority) throw new Error('INVALID_DEPOSIT_AUTHORITY');
  if (!config.withdrawAuthority) throw new Error('INVALID_WITHDRAW_AUTHORITY');
  if (!owner) throw new Error('INVALID_OWNER');
  return { config: { ...config }, owner, holdings: [], assetCount: 0 };
}

export function canDeposit(state: VesselState, caller: string): { allowed: boolean; reason: string } {
  const ok = caller === state.config.depositAuthority;
  return ok
    ? { allowed: true, reason: 'Caller is the vessel deposit authority.' }
    : { allowed: false, reason: 'Only the vessel deposit authority may deposit.' };
}

export function canWithdraw(state: VesselState, caller: string): { allowed: boolean; reason: string } {
  const ok = caller === state.config.withdrawAuthority;
  return ok
    ? { allowed: true, reason: 'Caller is the vessel withdraw authority.' }
    : { allowed: false, reason: 'Only the vessel withdraw authority may withdraw.' };
}

/** The holding invariant: recorded ledger must equal actual custody balance. */
function assertHoldingInvariant(holding: VesselHolding): void {
  if (holding.amount !== holding.custodyBalance) throw new Error('HOLDING_MISMATCH');
}

export function holdingOf(state: VesselState, mint: string): bigint {
  return state.holdings.find((h) => h.mint === mint)?.amount ?? 0n;
}

export function custodyBalanceOf(state: VesselState, mint: string): bigint {
  return state.holdings.find((h) => h.mint === mint)?.custodyBalance ?? 0n;
}

function cloneHoldings(state: VesselState): VesselHolding[] {
  return state.holdings.map((h) => ({ ...h }));
}

export function deposit(
  state: VesselState,
  caller: string,
  mint: string,
  amount: bigint,
  opts?: { mintExtensions?: string[] },
): VesselState {
  if (amount <= 0n) throw new Error('DEPOSIT_AMOUNT_NON_POSITIVE');
  const check = canDeposit(state, caller);
  if (!check.allowed) throw new Error(`DEPOSIT_NOT_PERMITTED: ${check.reason}`);
  // Mirrors the on-chain extension gate in `deposit_asset`. The simulation
  // cannot read mint data itself, so extensions must be supplied by the
  // caller; when omitted the check is skipped (a bare mint with no
  // extensions always passes on-chain).
  if (opts?.mintExtensions) assertAllowedAssetMintExtensions(opts.mintExtensions);
  const holdings = cloneHoldings(state);
  let assetCount = state.assetCount;
  let holding = holdings.find((h) => h.mint === mint);
  if (!holding) {
    holding = { mint, amount: 0n, custodyBalance: 0n };
    holdings.push(holding);
    assetCount += 1;
  }
  holding.amount += amount;
  holding.custodyBalance += amount;
  assertHoldingInvariant(holding);
  return { ...state, holdings, assetCount };
}

export function withdraw(state: VesselState, caller: string, mint: string, amount: bigint): VesselState {
  if (amount <= 0n) throw new Error('WITHDRAW_AMOUNT_NON_POSITIVE');
  const check = canWithdraw(state, caller);
  if (!check.allowed) throw new Error(`WITHDRAW_NOT_PERMITTED: ${check.reason}`);
  const holdings = cloneHoldings(state);
  const holding = holdings.find((h) => h.mint === mint);
  if (!holding) throw new Error('ASSET_NOT_HELD');
  if (holding.amount < amount) throw new Error('INSUFFICIENT_VESSEL_BALANCE');
  holding.amount -= amount;
  holding.custodyBalance -= amount;
  assertHoldingInvariant(holding);
  // The zero-balance record is kept (never closed), matching on-chain.
  return { ...state, holdings };
}

/**
 * Simulate a token transfer straight into the custody PDA, bypassing the
 * program (e.g. someone sends tokens to the custody account address
 * directly). On-chain this desynchronizes the ledger: the next deposit or
 * withdrawal fails with HoldingMismatch. `adoptStrayAssets` (below) is the
 * recovery path. `delta` must keep the custody balance non-negative.
 */
export function applyExternalBalanceChange(state: VesselState, mint: string, delta: bigint): VesselState {
  const holdings = cloneHoldings(state);
  const holding = holdings.find((h) => h.mint === mint);
  if (!holding) throw new Error('ASSET_NOT_HELD');
  const next = holding.custodyBalance + delta;
  if (next < 0n) throw new Error('EXTERNAL_CHANGE_UNDERFLOW');
  holding.custodyBalance = next;
  return { ...state, holdings };
}

/**
 * Simulate on-chain `adopt_stray_assets`: credit a stray custody balance
 * (tokens sent straight to the custody PDA, bypassing the program) into the
 * holding ledger, restoring the holding invariant so deposits and
 * withdrawals work again. Only the deposit or withdraw authority may call.
 * The ledger is only ever written UP to the custody balance — never down
 * (a shortfall throws HOLDING_MISMATCH, mirroring on-chain).
 */
export function adoptStrayAssets(state: VesselState, caller: string, mint: string): VesselState {
  const isAuthority =
    caller === state.config.depositAuthority || caller === state.config.withdrawAuthority;
  if (!isAuthority) throw new Error('ADOPT_NOT_PERMITTED: only a vessel authority may adopt stray assets.');
  const holdings = cloneHoldings(state);
  const holding = holdings.find((h) => h.mint === mint);
  if (!holding) throw new Error('ASSET_NOT_HELD');
  if (holding.custodyBalance < holding.amount) throw new Error('HOLDING_MISMATCH');
  holding.amount = holding.custodyBalance;
  assertHoldingInvariant(holding);
  return { ...state, holdings };
}

/**
 * Rotate the deposit authority. Only the current owner may call — mirrors
 * on-chain `update_deposit_authority`. Without rotation, a lost authority
 * key would lock the vessel's flows forever.
 */
export function updateDepositAuthority(
  state: VesselState,
  caller: string,
  newAuthority: string,
): VesselState {
  if (caller !== state.owner) throw new Error('ROTATE_NOT_PERMITTED: only the vessel owner may rotate authorities.');
  if (!newAuthority) throw new Error('INVALID_DEPOSIT_AUTHORITY');
  return { ...state, config: { ...state.config, depositAuthority: newAuthority } };
}

/**
 * Rotate the withdraw authority. Only the current owner may call — mirrors
 * on-chain `update_withdraw_authority`. Without rotation, a lost withdraw
 * key would lock the vessel's funds forever.
 */
export function updateWithdrawAuthority(
  state: VesselState,
  caller: string,
  newAuthority: string,
): VesselState {
  if (caller !== state.owner) throw new Error('ROTATE_NOT_PERMITTED: only the vessel owner may rotate authorities.');
  if (!newAuthority) throw new Error('INVALID_WITHDRAW_AUTHORITY');
  return { ...state, config: { ...state.config, withdrawAuthority: newAuthority } };
}

export interface OwnershipTransferSummary {
  previousOwner: string;
  newOwner: string;
  /** Every holding that moves with the container. */
  transferredHoldings: VesselHolding[];
  /**
   * Authority roles travel with the vessel config, still assigned to the
   * same keys — the transfer does NOT rotate them.
   */
  carriedAuthorities: { depositAuthority: string; withdrawAuthority: string };
  /** Always empty: nothing stays with the previous owner. */
  retainedByPreviousOwner: string[];
  custodyProgramUnchanged: string;
}

/**
 * Transfer container ownership. The previous owner retains NOTHING:
 * holdings, the authority config, and the asset count move to the new
 * owner; the assets themselves never move and the custody program is
 * unchanged. The deposit/withdraw authorities keep their roles (they are
 * not rotated by the transfer).
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
    carriedAuthorities: {
      depositAuthority: state.config.depositAuthority,
      withdrawAuthority: state.config.withdrawAuthority,
    },
    retainedByPreviousOwner: [],
    custodyProgramUnchanged: state.config.custodyProgram,
  };
  return { state: { ...state, owner: newOwner }, summary };
}
