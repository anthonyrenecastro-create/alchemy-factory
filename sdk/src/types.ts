/**
 * Shared types for the Alchemy Factory simulation engine.
 *
 * SIMULATION ONLY: nothing in the SDK touches the blockchain, a wallet, or the
 * network. Every function is pure and deterministic. Types here mirror the
 * on-chain config accounts defined in `programs/` but carry no authority.
 */

export type MechanicKind = 'dynamic' | 'decay' | 'vessel' | 'curve' | 'proofx' | 'vault';

export const MECHANIC_LABELS: Record<MechanicKind, string> = {
  dynamic: 'Dynamic & evolving',
  decay: 'Time-decaying',
  vessel: 'Hierarchical & nested',
  curve: 'Bonding-curve native',
  proofx: 'Proof of X',
  vault: 'Collateral vault',
};

/**
 * Privileged authorities attached to an experiment's mint.
 * Every field is surfaced live in the holder app BEFORE any signature.
 */
export interface AuthoritySet {
  /** Base58 pubkey that can mint new tokens, or null if minting is closed. */
  mintAuthority: string | null;
  /** Base58 pubkey that can freeze holder accounts, or null. */
  freezeAuthority: string | null;
  /** Base58 pubkey that can push oracle/dynamic updates, or null. */
  updateAuthority: string | null;
  /**
   * POWERFUL: a permanent delegate can transfer or burn ANY holder's tokens
   * without their consent. The studio requires a separate explicit confirmation
   * to enable this; the holder app shows it as a blocking warning.
   */
  permanentDelegate: string | null;
  /**
   * Transfer hooks require a hook program and create wallet/DEX integration
   * friction. Never enabled silently; always disclosed with a warning.
   */
  transferHookProgram: string | null;
}

export interface ExperimentConfig {
  name: string;
  symbol: string;
  /** Token decimals, 0..9. */
  decimals: number;
  mechanic: MechanicKind;
  authorities: AuthoritySet;
  /** Token-2022 extensions selected BEFORE mint creation, e.g. 'transfer-hook'. */
  extensions: string[];
}

export interface HolderRight {
  title: string;
  /** Plain-English description of what the holder can expect. */
  description: string;
}

export interface HolderRightsSummary {
  rights: HolderRight[];
  warnings: string[];
}

export interface CostLineItem {
  label: string;
  lamports: bigint;
  detail: string;
}

export interface CostEstimate {
  items: CostLineItem[];
  totalLamports: bigint;
  /** Human-readable SOL amount, e.g. "0.0142". */
  totalSol: string;
  network: 'devnet';
  /** Estimates only — not a quote; mainnet rent/fees can differ. */
  note: string;
}

export type WarningSeverity = 'info' | 'warning' | 'blocking';

export interface CompatibilityWarning {
  severity: WarningSeverity;
  code: string;
  message: string;
}

/** Rendered token listing used by the holder app (sample data is labeled). */
export interface TokenListing {
  mint: string;
  name: string;
  symbol: string;
  mechanic: MechanicKind;
  /** true when this entry is illustrative sample data, not a real token. */
  isSample: boolean;
  authorities: AuthoritySet;
  extensions: string[];
  fees: string;
  risks: string[];
  redemptionTerms: string;
  expiry: string | null;
}
