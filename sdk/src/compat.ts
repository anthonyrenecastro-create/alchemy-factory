/**
 * Token-2022 extension compatibility checker (Stage 2).
 *
 * CHECKER ONLY: pure functions, no network, no wallet, no chain state.
 * Fully deterministic — same input always yields the same report.
 *
 * Encodes the research in `docs/research/token2022-extensions.md` and
 * `docs/research/wallet-dex-compatibility.md` (both dated 2026-09-27):
 * the five protocol-enforced combination rules (source: solana-program/token-2022,
 * commit 426400f, dated 2026-08-17), the per-extension wallet/DEX friction table,
 * and the per-mechanic recommendations (Cases 1–6).
 *
 * HONESTY RULES (docs/STAGES.md): findings never claim production readiness,
 * guaranteed yield, or universal wallet/DEX compatibility. Red findings are
 * never presented as safe — they require explicit creator acknowledgment
 * (blocked=true) before the studio proceeds. Venue stances carry vintage labels
 * ("Sep-2026 docs", "Apr-2026 vintage — re-verify"); anything not verified on
 * devnet is labeled as such, never asserted.
 */

/** All Token-2022 extensions this checker can evaluate. */
export type Token2022Extension =
  | 'metadata-pointer' | 'token-metadata' | 'mint-close-authority'
  | 'transfer-fee' | 'transfer-hook' | 'permanent-delegate'
  | 'non-transferable' | 'confidential-transfer' | 'confidential-transfer-fee'
  | 'interest-bearing' | 'scaled-ui-amount' | 'default-account-state-frozen'
  | 'immutable-owner' | 'memo-transfer' | 'pausable' | 'permissioned-burn' | 'cpi-guard';

export type Severity = 'green' | 'amber' | 'red';

export interface CompatFinding {
  /** Extension or combination this finding is about. */
  subject: string;
  severity: Severity;
  title: string;
  /** Plain-English explanation with the concrete consequence. */
  explanation: string;
  /** True when the studio UI must block until the creator explicitly acknowledges. */
  requiresAcknowledgment: boolean;
  /** Venue/wallet specifics, e.g. "Raydium: blocked from pools (Sep-2026 docs)". */
  venueNotes: string[];
}

export interface CompatReport {
  extensions: Token2022Extension[];
  overall: Severity; // worst severity across findings
  findings: CompatFinding[];
  /** True when at least one finding requires acknowledgment. */
  blocked: boolean;
  protocolValid: boolean; // false when a protocol-enforced combination rule is violated
}

/** Alchemy Factory mechanic families that receive extension recommendations. */
export type MechanicFamily = 'curve' | 'decay' | 'dynamic' | 'vessel' | 'proofx' | 'vault';

const SEVERITY_RANK: Record<Severity, number> = { green: 0, amber: 1, red: 2 };

/**
 * Evaluate a Token-2022 extension set for protocol legality and wallet/DEX
 * friction. Pure and deterministic; no network, no wallet.
 */
export function checkCompatibility(extensions: Token2022Extension[]): CompatReport {
  const unique = [...new Set(extensions)];
  const has = (e: Token2022Extension): boolean => unique.includes(e);
  const findings: CompatFinding[] = [];
  let protocolValid = true;

  // ---- Protocol-enforced combination rules (init-time invalid) ----
  // These are the ONLY combinations the Token-2022 program rejects at mint
  // initialization (TokenError::InvalidExtensionCombination).

  // Rule 4: ScaledUiAmount × InterestBearingConfig are mutually exclusive —
  // the one true mutual exclusion (both rewrite the displayed amount).
  const scaledAndInterest = has('scaled-ui-amount') && has('interest-bearing');
  if (scaledAndInterest) {
    protocolValid = false;
    findings.push({
      subject: 'scaled-ui-amount + interest-bearing',
      severity: 'red',
      title: 'Protocol-invalid: scaled-ui-amount and interest-bearing are mutually exclusive',
      explanation:
        'The Token-2022 program rejects this combination at mint initialization ' +
        '(TokenError::InvalidExtensionCombination, rule 4): both extensions rewrite the displayed UI ' +
        'amount and the program refuses the ambiguity. Source: solana-program/token-2022 ' +
        'check_for_invalid_mint_extension_combinations, commit 426400f, dated 2026-08-17. ' +
        'This mint cannot be created as configured — pick exactly one of the two ' +
        '(the decay mechanic maps its schedule onto a decaying multiplier OR a compounding rate, ' +
        'never both).',
      requiresAcknowledgment: true,
      venueNotes: [],
    });
  }

  // Rule 1: ConfidentialTransferFeeConfig requires BOTH TransferFeeConfig
  // AND ConfidentialTransferMint.
  const fee = has('transfer-fee');
  const ct = has('confidential-transfer');
  const ctFee = has('confidential-transfer-fee');
  if (ctFee && !(fee && ct)) {
    protocolValid = false;
    findings.push({
      subject: 'confidential-transfer-fee (missing dependency)',
      severity: 'red',
      title: 'Protocol-invalid: confidential-transfer-fee requires transfer-fee AND confidential-transfer',
      explanation:
        'ConfidentialTransferFeeConfig requires BOTH TransferFeeConfig and ConfidentialTransferMint ' +
        '(rule 1). This mint cannot be created as configured — add the missing companion extension(s), ' +
        'or drop confidential-transfer-fee.',
      requiresAcknowledgment: true,
      venueNotes: [],
    });
  }

  // Rule 2: TransferFeeConfig + ConfidentialTransferMint together REQUIRE
  // ConfidentialTransferFeeConfig (the set is incomplete, not contradictory —
  // adding the third extension fixes it).
  if (fee && ct && !ctFee) {
    protocolValid = false;
    findings.push({
      subject: 'transfer-fee + confidential-transfer (incomplete set)',
      severity: 'red',
      title: 'Protocol-invalid: transfer-fee + confidential-transfer require confidential-transfer-fee',
      explanation:
        'TransferFeeConfig + ConfidentialTransferMint together require ConfidentialTransferFeeConfig ' +
        '(rule 2). This mint cannot be created as configured — the set is incomplete, not contradictory: ' +
        'adding confidential-transfer-fee fixes it.',
      requiresAcknowledgment: true,
      venueNotes: [],
    });
  }

  // Rule 5: NonTransferable + ConfidentialTransferMint is invalid UNLESS
  // ConfidentialMintBurn is also present. This checker's extension vocabulary
  // has no confidential-mint-burn option, so any confidential-transfer* paired
  // with non-transferable is treated as red/protocol-suspect.
  const nonXfer = has('non-transferable');
  if (nonXfer && (ct || ctFee)) {
    protocolValid = false;
    findings.push({
      subject: 'non-transferable + confidential-transfer*',
      severity: 'red',
      title: 'Protocol-suspect: non-transferable with confidential transfers',
      explanation:
        'NonTransferable + ConfidentialTransferMint is init-invalid unless ConfidentialMintBurn is also ' +
        'present (rule 5). This checker has no confidential-mint-burn extension option, so any ' +
        'confidential-transfer* paired with non-transferable is treated as red/protocol-suspect — ' +
        'do not ship a design that depends on this pair without verifying actual init behavior on devnet.',
      requiresAcknowledgment: true,
      venueNotes: [],
    });
  }

  // ---- Per-extension wallet/DEX friction findings ----

  // Transfer hook + transfer fee: the two most integration-hostile extensions
  // stacked — escalated hard warning, replaces the individual findings.
  if (has('transfer-hook') && fee) {
    findings.push({
      subject: 'transfer-hook + transfer-fee',
      severity: 'red',
      title: 'Escalated hard warning: transfer hook stacked with transfer fee',
      explanation:
        'The two most integration-hostile extensions stacked. The fee changes the delivered amount on ' +
        'every transfer while the hook forces every venue to resolve extra accounts and run foreign code. ' +
        'Aggregators are advised to skip transfer-hook mints by default (Raydium security docs, Sep-2026), ' +
        'so this token should be expected to be unroutable on Jupiter/Phantom swap; every pool quote must ' +
        'do fee-aware math AND hook-aware construction. The hook program is upgradeable: a buggy or ' +
        'malicious upgrade can freeze all transfers (documented soft-rug vector). Only enable both when ' +
        'the mechanic genuinely requires both, with the creator explicitly acknowledging the token may ' +
        'not be swappable.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: hook allowed with caveats via SwapV2, UI flags hook pools; fee-aware math documented (Sep-2026 docs)',
        'Meteora: badge-gated unless hook program + authority revoked (Sep-2026 docs)',
        'Orca Whirlpools: requires TokenBadge for hook mints (Sep-2026 docs)',
      ],
    });
  } else if (has('transfer-hook')) {
    findings.push({
      subject: 'transfer-hook',
      severity: 'red',
      title: 'Hard warning: transfer hook',
      explanation:
        'Every downstream venue must know how to invoke the hook with the right accounts, which breaks ' +
        'aggregator routing in practice: Jupiter quotes may simply not return, and Raydium\'s security docs ' +
        'advise aggregators to skip transfer-hook mints by default (Sep-2026). Every integrator must pass ' +
        'hook extra accounts (missing accounts cause MissingAccount failures), each transfer pays extra ' +
        'compute overhead, and the hook also fires on account close — rent-reclamation flows must account ' +
        'for it. Hook programs are upgradeable: a malicious or buggy upgrade can freeze all transfers ' +
        '(documented soft-rug vector). Enable only when the mechanic genuinely needs on-transfer ' +
        'enforcement (expiry, oracle freshness, composition rules), and only after devnet verification ' +
        'of wallet send UX and aggregator routing.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: allowed with caveats via SwapV2; UI flags pools with transfer-hook mints (Sep-2026 docs)',
        'Meteora: permissionless only if hook program + authority revoked, else token badge (Sep-2026 docs)',
        'Orca Whirlpools: requires initialized TokenBadge (Sep-2026 docs)',
        'Jupiter: no published hook allowlist/blocklist; quote-or-no-quote (Sep-2026)',
      ],
    });
  }

  // Transfer fee alone: tradeable with the four caveats.
  if (fee && !has('transfer-hook')) {
    findings.push({
      subject: 'transfer-fee',
      severity: 'amber',
      title: 'Tradeable with caveats: transfer fee',
      explanation:
        'Tradeable on compatible venues, but four caveats apply. (1) Every transfer delivers less than ' +
        'sent: the fee is withheld on the RECIPIENT\'s account (untouchable by the recipient) and ' +
        'harvested later by the withdraw authority — sells into a program vault would strand fees in the ' +
        'program\'s own account, so the program must account on balance deltas, not declared amounts. ' +
        '(2) The fee authority can change the rate across an epoch boundary, so quoted "you receive" ' +
        'amounts can drift; fee changes and max-fee caps are the main foot-gun. (3) Jupiter ' +
        'Recurring/DCA does not accept transfer-fee tokens. (4) DEX UIs check slippage bounds on the ' +
        'gross sent amount, not the net received. Transfers must use transfer_checked / ' +
        'transfer_checked_with_fee.',
      requiresAcknowledgment: false,
      venueNotes: [
        'Raydium CPMM/CLMM: supported via SwapV2 with fee-aware math (Sep-2026 docs)',
        'Meteora DLMM: permissionless (Sep-2026 docs)',
        'Orca Whirlpools: supported (since Oct 2024)',
        'Jupiter: routes via compatible venues — a returned quote is the practical confirmation (Oct-2025 vintage — re-verify)',
        'Phantom shows fees on the confirmation screen; Solflare Shield previews deductions (Apr-2026 vintage — re-verify)',
      ],
    });
  }

  if (has('permanent-delegate')) {
    findings.push({
      subject: 'permanent-delegate',
      severity: 'red',
      title: 'Hard warning: permanent delegate — custody red flag',
      explanation:
        'An irrevocable authority that can transfer or burn ANY holder\'s tokens without consent — a ' +
        'custody red flag, not a display issue. It bypasses CPI Guard (official extension guide), fails ' +
        'against confidential balances, and breaks the solvency invariant of any program-held vault (a ' +
        'delegate can seize the vault\'s share accounts — the "custodied vault seizure" vector in the ' +
        'Sep-2026 auditor knowledge base). If a mechanic needs admin burn powers, use permissioned-burn ' +
        'instead (co-signed burns, no seizure power). The delegate authority and its holder must be ' +
        'labeled prominently — never silently enabled (STAGES.md).',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: blocked from pools entirely (Sep-2026 docs)',
        'Orca Whirlpools: requires TokenBadge (Sep-2026 docs)',
        'Wallets show warnings (Phantom "full incl. warnings", Apr-2026 vintage — re-verify)',
      ],
    });
  }

  if (nonXfer) {
    findings.push({
      subject: 'non-transferable',
      severity: 'red',
      title: 'Hard warning: non-transferable — blocked from trading',
      explanation:
        'Soulbound by design: transfers are rejected except to and from the mint authority, so the ' +
        'token cannot be LP\'d and will never trade on open venues. That is the point for ' +
        'attestation/badge mechanics — the program can still distribute by minting directly to ' +
        'recipients, and holders can still burn and close their accounts. Every holder account is ' +
        'forced to carry NonTransferableAccount + ImmutableOwner (closes the "transfer the account ' +
        'instead of the token" loophole) — rent paid per holder, forever. Only sane for soulbound ' +
        'credentials; confirm the creator understands the token will never trade.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: CreatePool rejects non-transferable mints (Sep-2026 docs)',
        'Orca Whirlpools: not supported (Sep-2026 docs)',
        'Meteora: token badge required (Sep-2026 docs)',
      ],
    });
  }

  if (ct) {
    findings.push({
      subject: 'confidential-transfer',
      severity: 'red',
      title: 'Hard warning: confidential transfers',
      explanation:
        'No wallet documents UI support for configuring confidential accounts or viewing encrypted ' +
        'balances (Phantom/Solflare/Backpack all undocumented — treat as unsupported-by-default). ' +
        'Transfers are 48-bit-capped and compute-heavy, with a pending/available two-step balance model ' +
        'requiring per-account ElGamal keypairs. The ZK proof program was disabled Jun 2025–Jun 2026 ' +
        'and re-enabled 2026-06-04 (Sep-2026 third-party analysis); pool math needs cleartext, so a ' +
        'confidential mint is effectively unroutable on DEXes. Confidential mint/burn is mint-level ' +
        'opt-in at creation and cannot be added later. Do not offer as a one-click extension until a ' +
        'wallet documents support.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: blocked from pools (Sep-2026 docs)',
        'Orca Whirlpools: only non-confidential transfers usable in pools (Sep-2026 docs)',
      ],
    });
  }

  if (ctFee) {
    findings.push({
      subject: 'confidential-transfer-fee',
      severity: 'red',
      title: 'Hard warning: confidential-transfer fee config',
      explanation:
        'All confidential-transfer friction above applies (no documented wallet UI, venue blocks, ' +
        '48-bit-capped CU-heavy transfers). Additionally, the fee config only functions together with ' +
        'transfer-fee and confidential-transfer (protocol rules 1–2) — an incomplete set is rejected ' +
        'at mint initialization.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: blocked from pools (Sep-2026 docs)',
        'Orca Whirlpools: only non-confidential transfers usable in pools (Sep-2026 docs)',
      ],
    });
  }

  // Interest-bearing alone: display-only; individual caveats.
  // (Skipped when the red scaled-ui-amount × interest-bearing finding fired —
  // the combination, not the extension, is the story there.)
  if (has('interest-bearing') && !scaledAndInterest) {
    findings.push({
      subject: 'interest-bearing',
      severity: 'amber',
      title: 'Tradeable with caveats: interest-bearing',
      explanation:
        'LP-able on Raydium and Orca, but two caveats. (1) No wallet documents showing the scaled ' +
        'balance: holders may see the RAW amount (which understates the redeemable amount) — display ' +
        'math is unverified; do not assert, verify on devnet. (2) Raydium pools read raw vault balances, ' +
        'ignoring accrual, so accrued interest leaks to LPs on redeem — documented as benign but worth ' +
        'disclosing. The rate is display-only ("no new tokens are ever created", official guide): never ' +
        'present it as yield (STAGES.md). Mutually exclusive with scaled-ui-amount (protocol rule 4).',
      requiresAcknowledgment: false,
      venueNotes: [
        'Raydium: allowed, pool math reads raw balances (Sep-2026 docs)',
        'Orca Whirlpools: supported (since Oct 2024)',
        'Wallet display of scaled balance unverified (Apr-2026 vintage — re-verify on devnet)',
      ],
    });
  }

  // Scaled UI amount alone: wallet rendering unverified, cosmetic only.
  if (has('scaled-ui-amount') && !scaledAndInterest) {
    findings.push({
      subject: 'scaled-ui-amount',
      severity: 'amber',
      title: 'Tradeable with caveats: scaled UI amount',
      explanation:
        'Rewrites the DISPLAYED UI amount via an adjustable multiplier (with optional effective ' +
        'timestamp); raw on-chain amounts never change — "entirely cosmetic" (official guide). ' +
        'Wallet/indexer rendering of the multiplier is unverified: no source found confirming ' +
        'Phantom/Solflare display it, so verify on devnet and document the display/raw split in the ' +
        'UI (STAGES.md honesty rules). Any redemption/settlement logic must use raw amounts. ' +
        'Mutually exclusive with interest-bearing (protocol rule 4).',
      requiresAcknowledgment: false,
      venueNotes: [
        'Meteora badge review path explicitly names "scaled UI amounts" as swap-affecting (Sep-2026 docs)',
        'Wallet rendering unverified — test on devnet (no 2026 source found)',
      ],
    });
  }

  if (has('default-account-state-frozen')) {
    findings.push({
      subject: 'default-account-state-frozen',
      severity: 'red',
      title: 'Hard warning: default account state frozen',
      explanation:
        'Transfers fail (AccountFrozen 0x11) until the freeze authority thaws each account — every ' +
        'holder needs an extra thaw step, and NEW accounts land frozen too. Only appropriate with an ' +
        'automated thaw/onboarding flow, and the freeze authority holder must be disclosed. Clumsy ' +
        'versus a transfer hook for time-bounded restrictions (e.g. post-expiry decay): the hook only ' +
        'restricts what the mechanic requires.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Raydium: blocked — pool ATAs would land frozen (Sep-2026 docs)',
        'Orca Whirlpools: requires TokenBadge; default state must be Initialized (Sep-2026 docs)',
        'Phantom/Solflare display frozen status "with explanation" (Apr-2026 vintage — re-verify)',
        'Subscription/payment rails reject frozen-default mints',
      ],
    });
  }

  if (has('memo-transfer')) {
    findings.push({
      subject: 'memo-transfer',
      severity: 'amber',
      title: 'Warn: memo-required transfers',
      explanation:
        'Every transfer must carry a memo or it fails — compliance-only use. Receiver-side wallet ' +
        'enforcement is undocumented: plain wallet sends may fail without the sender understanding why. ' +
        'Test wallet send UX on devnet before relying on it.',
      requiresAcknowledgment: false,
      venueNotes: [
        'Orca Whirlpools: handles memo-required via V2 instructions (Sep-2026 docs)',
        'Meteora DLMM: handles it (Sep-2026 docs)',
        'Wallet enforcement undocumented (Apr-2026 vintage — re-verify)',
      ],
    });
  }

  if (has('pausable')) {
    findings.push({
      subject: 'pausable',
      severity: 'red',
      title: 'Hard warning: pausable — global kill switch',
      explanation:
        'A pause authority can halt ALL transfers at any time: a global kill switch and a heavy trust ' +
        'assumption. Rejected by payment/subscription rails. Every holder account is forced to carry ' +
        'PausableAccount (rent paid per holder, forever). Not recommended for any Alchemy Factory ' +
        'mechanic in the research; if ever enabled, the pause authority holder must be disclosed and ' +
        'the liveness dependency documented.',
      requiresAcknowledgment: true,
      venueNotes: [
        'Payment/subscription rails reject pausable mints',
        'Wallet paused-state display unverified (by analogy with frozen only — re-verify)',
      ],
    });
  }

  if (has('permissioned-burn')) {
    findings.push({
      subject: 'permissioned-burn',
      severity: 'amber',
      title: 'Caution: permissioned burn (new extension)',
      explanation:
        'Every burn needs the burn authority\'s co-signature; regular Burn/BurnChecked instructions are ' +
        'rejected once the authority is set (official guide). New extension (shipped in Token-2022 v11, ' +
        'mid-2026): no wallet path documented for the permissioned-burn instruction — program-driven ' +
        'burns only, which is acceptable when the program (decay settlement, proof-of-X revocation, ' +
        'vault supply discipline) drives burns. This is the SCOPED alternative to permanent delegate: ' +
        'co-signed burns with no transfer/seizure power. Combines freely with non-transferable (not in ' +
        'the conflict guards).',
      requiresAcknowledgment: false,
      venueNotes: [
        'New in Token-2022 v11 (mid-2026); no venue data found — program, not wallet, drives burns',
        'Production pattern in Sep-2026 RWA work (devlab-group RWA audit; Solana Foundation enterprise-training MMF example)',
      ],
    });
  }

  if (has('mint-close-authority')) {
    findings.push({
      subject: 'mint-close-authority',
      severity: 'green',
      title: 'Safe: mint close authority',
      explanation:
        'Allows the mint account itself to be closed and its rent reclaimed — only when supply is 0 ' +
        '(official guide). No holder impact. Useful for retiring a fully-unwound curve or an expired ' +
        'decay token whose supply has been burned to zero.',
      requiresAcknowledgment: false,
      venueNotes: [
        'Raydium docs conflict at Sep-2026 vintage: support reference says "disallowed by default", fundamentals page says "fully allowed" — do not assume pool support',
        'Orca Whirlpools: requires TokenBadge (Sep-2026 docs)',
      ],
    });
  }

  if (has('immutable-owner')) {
    findings.push({
      subject: 'immutable-owner',
      severity: 'green',
      title: 'Safe: immutable owner',
      explanation:
        'Inert account-level protection against owner-reassignment tricks. Automatic on all ' +
        'associated token accounts (official guide) — zero friction; forced by non-transferable on ' +
        'every holder account.',
      requiresAcknowledgment: false,
      venueNotes: [],
    });
  }

  // CPI guard is carried as a green note rather than a finding: it is
  // account-level and inert unless misapplied to program vaults.
  if (has('cpi-guard')) {
    findings.push({
      subject: 'cpi-guard',
      severity: 'green',
      title: 'Note: CPI guard',
      explanation:
        'User opt-in per account. Do NOT enable on program vault accounts: it would block the ' +
        'program\'s own owner-signed CPI transfers (e.g. a vault\'s withdraw path). Note also that ' +
        'the permanent delegate bypasses CPI Guard (official guide) — the guard is not a defense ' +
        'against a delegate.',
      requiresAcknowledgment: false,
      venueNotes: [],
    });
  }

  // ---- Combination cautions (legal to initialize, flagged by research) ----

  // Docs-vs-code tension: several doc pages claim NonTransferable +
  // TransferFeeConfig cannot be combined, but the five enforced rules say
  // nothing about the pair — verify on devnet, rely on neither claim.
  if (nonXfer && fee) {
    findings.push({
      subject: 'non-transferable + transfer-fee',
      severity: 'amber',
      title: 'Unverified combination: non-transferable + transfer-fee',
      explanation:
        'Docs-vs-code tension: several doc pages (incl. Sep-2026 writeups) claim this pair cannot be ' +
        'combined, but the program\'s five enforced combination rules say nothing about it — it is a ' +
        'doc-level "makes no sense" caution, not an init-time rejection. Do not rely on either claim: ' +
        'verify on devnet before shipping a design that depends on it.',
      requiresAcknowledgment: false,
      venueNotes: [],
    });
  }

  // Technically legal (absent from the five guards), practically pointless:
  // no ordinary transfers exist for the hook to enhance.
  if (nonXfer && has('transfer-hook')) {
    findings.push({
      subject: 'non-transferable + transfer-hook',
      severity: 'amber',
      title: 'Practically pointless: non-transferable + transfer hook',
      explanation:
        'Technically legal (absent from the five enforced guards), but there are no ordinary ' +
        'transfers for the hook to enhance — the hook would never fire. Drop the hook and keep the ' +
        'mint simple.',
      requiresAcknowledgment: false,
      venueNotes: [],
    });
  }

  // Nothing but the inert metadata baseline: confirm the safest case.
  if (findings.length === 0) {
    findings.push({
      subject: 'metadata-only baseline',
      severity: 'green',
      title: 'Safest baseline: metadata only',
      explanation:
        'MetadataPointer + TokenMetadata is the ecosystem-standard baseline (e.g. pump.fun Token-2022 ' +
        'mints, Sep-2026 mainnet study). Displays in Phantom/Solflare/Backpack like SPL tokens; no ' +
        'transfer-time surprises; routable on Jupiter; LP-able on Raydium CPMM/CLMM and Orca Whirlpools ' +
        'without any badge (Sep-2026 docs). Note: some extensions (confidential mint/burn) are ' +
        'mint-level opt-in and cannot be added later — choose the final set before creation, and ' +
        'verify pool behavior on devnet before claiming compatibility.',
      requiresAcknowledgment: false,
      venueNotes: [
        'Raydium: fully allowed (Sep-2026 docs)',
        'Orca Whirlpools: supported (Sep-2026 docs)',
        'Meteora DLMM: permissionless (Sep-2026 docs)',
      ],
    });
  }

  const overall = findings.reduce<Severity>(
    (worst, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst] ? f.severity : worst),
    'green',
  );
  const blocked = findings.some((f) => f.requiresAcknowledgment);

  return { extensions: unique, overall, findings, blocked, protocolValid };
}

/**
 * Vault collateral allow-list check (Stage 3).
 *
 * MIRRORS the on-chain gate in `alchemy_vault`'s `validate_collateral_mint`
 * (programs/programs/alchemy_vault/src/lib.rs) EXACTLY: the program accepts
 * ONLY `metadata-pointer`, `token-metadata`, and `mint-close-authority` on
 * the collateral mint and rejects everything else with
 * VaultError::InvalidCollateralMint. This is a pure, deterministic,
 * off-chain pre-check — the on-chain program is the binding authority;
 * this function exists so the studio surfaces the same verdict before the
 * creator pays for a transaction that would fail.
 *
 * NOTE: this policy explicitly rejects the real PAXG mint in Stage 3 (it
 * carries a permanent delegate). Accepting real PAXG is a Stage-4 decision
 * made as an explicit per-mint allow-list entry, never by widening this rule.
 * This is our own review tooling, not an external audit.
 */

/** Extensions the on-chain vault accepts on the collateral mint. */
export const VAULT_COLLATERAL_ALLOWED_EXTENSIONS: Token2022Extension[] = [
  'metadata-pointer',
  'token-metadata',
  'mint-close-authority',
];

export interface VaultCollateralVerdict {
  /** True when the on-chain program would accept this extension set. */
  allowed: boolean;
  /** Extensions the on-chain allow-list rejects (empty when allowed). */
  rejected: Token2022Extension[];
}

export function checkVaultCollateral(extensions: Token2022Extension[]): VaultCollateralVerdict {
  const unique = [...new Set(extensions)];
  const rejected = unique.filter(
    (e) => !VAULT_COLLATERAL_ALLOWED_EXTENSIONS.includes(e),
  );
  return { allowed: rejected.length === 0, rejected };
}

/**
 * Research-backed Token-2022 extension recommendation per mechanic family
 * (docs/research/token2022-extensions.md, Cases 1–6). The returned set is the
 * safe baseline; red-flagged or optional extensions are described in `notes`,
 * never silently enabled. Run the result through checkCompatibility() to see
 * the exact findings the studio must surface.
 *
 * Pure and deterministic; no network, no wallet.
 */
export function recommendExtensions(
  mechanic: MechanicFamily,
): { recommended: Token2022Extension[]; notes: string } {
  switch (mechanic) {
    case 'curve':
      return {
        recommended: ['metadata-pointer', 'token-metadata'],
        notes:
          'Bonding-curve native token (Case 1): the program mints/burns, so buy/sell fees are PROGRAM ' +
          'math, not the transfer-fee extension — do NOT use TransferFeeConfig for curve fees (the ' +
          'extension fee applies to transfers, not MintTo/Burn; withheld fees would strand value in the ' +
          'vault account). Optional: mint-close-authority to retire the mint once the curve fully ' +
          'unwinds (supply 0) — note Raydium\'s Sep-2026 docs conflict on its pool support. Rejected ' +
          'for this mechanic: transfer-hook (mint authority is already the program), permanent-delegate ' +
          '(venue-blocked seizure power), non-transferable (kills the secondary market), ' +
          'interest-bearing/scaled-ui-amount (display-only cosmetics), confidential suite ' +
          '(venue-blocked). Verify pool behavior on devnet; never promise universal wallet/DEX compatibility.',
      };
    case 'decay':
      return {
        recommended: ['metadata-pointer', 'token-metadata', 'scaled-ui-amount'],
        notes:
          'Time-decaying token (Case 2): pick EXACTLY ONE of scaled-ui-amount XOR interest-bearing ' +
          '(protocol rule 4 — the pair is init-invalid). Default pick is scaled-ui-amount: the ' +
          'adjustable multiplier with effective-timestamp suits step decay; interest-bearing suits ' +
          'continuous compounding via network time instead. Both are DISPLAY-only — raw on-chain ' +
          'amounts never change, so redemption/settlement logic must use raw amounts and the UI must ' +
          'document the display/raw split (STAGES.md). Wallet rendering of the multiplier is unverified ' +
          '— test on devnet. Optional, red-flagged: transfer-hook to enforce expiry / per-period decay ' +
          'settlement at transfer time (MintTo does NOT fire the hook — guard the mint path in the ' +
          'program; expect aggregator routing friction and badge gates). Optional: permissioned-burn ' +
          '(program co-signs privileged decay burns; the scoped alternative to permanent-delegate) and ' +
          'mint-close-authority (retire the mint once post-expiry burns reach supply 0). Rejected: ' +
          'permanent-delegate (use permissioned-burn), non-transferable (wrong tool for post-expiry-only ' +
          'restrictions), default-account-state-frozen (freezes new accounts too; Raydium blocked).',
      };
    case 'dynamic':
      return {
        recommended: ['metadata-pointer', 'token-metadata'],
        notes:
          'Dynamic / oracle-fed token (Case 3): oracle-driven name/parameters/URI updates go through ' +
          'on-chain metadata with the program/DAO as update authority. Supply changes (mint/burn) need ' +
          'no extension — program-held mint authority is a first-class concept, not an extension: the ' +
          'program mints/burns after verifying the oracle attestation (signature, freshness, publisher ' +
          'allow-list). MintTo does not fire the transfer hook, so all oracle validation must live in ' +
          'the program\'s mint instruction (Sep-2026 audit finding). Optional, red-flagged: transfer-hook ' +
          'to gate transfers on oracle freshness (fail-closed: a stale feed halts transfers — document ' +
          'the liveness dependency). Rejected as the "dynamic" mechanism: interest-bearing/scaled-ui-amount ' +
          'when the oracle already changes supply via real mints/burns (a second cosmetic number confuses ' +
          'holders and auditors); permanent-delegate (unnecessary seizure power, venue-blocked); ' +
          'confidential suite (combination-rules minefield, venue-blocked).',
      };
    case 'vessel':
      return {
        recommended: ['metadata-pointer', 'token-metadata'],
        notes:
          'Hierarchical / nested container (Case 4): the extension choice depends on whether the ' +
          'container must trade on DEXes. Option B (this default): plain fungible mint (metadata ' +
          'describing the basket) + optional red-flagged transfer-hook enforcing composition rules on ' +
          'transfer — keeps the token routable on hook-tolerant venues (Raydium CPMM/CLMM via SwapV2 ' +
          '"allowed with caveats", Meteora/Orca via token badge; Sep-2026 docs) while composition ' +
          'logic stays upgradeable in the hook program. Option C: off-token container (program account ' +
          'holds the set; separate plain share token) — zero extension friction, maximum flexibility, ' +
          'composition visible only via program/indexer. Option A (TokenGroup/GroupPointer + ' +
          'TokenMember/MemberPointer): declarative and native, but Orca explicitly does not support ' +
          'group pointers and Raydium lists them "disallowed by default" — effectively non-tradable on ' +
          'the two largest Solana DEXes; only for never-traded, program-managed containers. The hook\'s ' +
          'extra accounts must be resolvable by every client — test on devnet.',
      };
    case 'proofx':
      return {
        recommended: [
          'metadata-pointer',
          'token-metadata',
          'non-transferable',
          'immutable-owner',
          'permissioned-burn',
        ],
        notes:
          'Proof-of-X credentials (Case 5): soulbound by design. non-transferable is the point — the ' +
          'token CANNOT be LP\'d on Raydium/Orca and will never trade (the red finding is expected here; ' +
          'confirm the creator understands non-swappability is the intent). immutable-owner is forced by ' +
          'non-transferable on every holder account (closes the "transfer the account instead of the ' +
          'token" loophole). The program mints directly to recipients (mint authority can still move ' +
          'tokens) and holders can still burn and close their accounts. permissioned-burn with the ' +
          'program PDA as burn authority gives issuer REVOCATION without seizure power — the scoped ' +
          'alternative to permanent-delegate. Credential schema (attestation type, issuer, expiry) lives ' +
          'in token-metadata; optional mint-close-authority retires the mint at supply 0. Rejected: ' +
          'permanent-delegate (unlimited irrevocable seizure, venue-blocked), transfer-hook ' +
          '(technically legal but practically pointless — no ordinary transfers to enhance), confidential ' +
          'suite (rule 5 minefield; credentials need auditability, not encryption), transfer-fee (no ' +
          'transfers, no fees — docs-vs-code tension unverified).',
      };
    case 'vault':
      return {
        recommended: ['metadata-pointer', 'token-metadata'],
        notes:
          'Collateral-vault share token (Case 6): the share mint stays plain and maximally compatible ' +
          '— share accounting, redemption pricing, withdrawal limits, and the deposits >= claims ' +
          'solvency invariant live in the vault program (STAGES.md Stage 3: program-tested invariants, ' +
          'off-chain calculated collateral value, never an on-chain price promise). Rejected on the ' +
          'share mint: interest-bearing (display-only "yield" implies the automatic yield STAGES.md ' +
          'disclaims), scaled-ui-amount (a cosmetic multiplier risks being read as a guaranteed ' +
          'redemption value), permanent-delegate (seizure breaks the solvency invariant — "custodied ' +
          'vault seizure" vector, Sep-2026 auditor knowledge base), transfer-fee (redemption fees belong ' +
          'in program math; withheld fees strand value in vault accounts and the fee authority could ' +
          'change the rate), confidential transfers (solvency needs public auditability). Optional, ' +
          'gated: transfer-hook for redemption windows / holder allow-lists (usual hook venue cost); ' +
          'permissioned-burn with the vault program as burn authority keeps on-chain supply an honest ' +
          'mirror of vault liabilities. REQUIRED regardless: validate the COLLATERAL mint\'s extensions ' +
          'before custody — reject hostile configs (permanent-delegate, frozen-default, unexpected ' +
          'transfer fees) or explicitly allow-list a vetted mint. Reference: PayPal\'s PYUSD Solana mint ' +
          'carries permanent-delegate/transfer-fee extensions (Sep-2026 Chainstack doc) — decide before ' +
          'mainnet whether that shape is acceptable.',
      };
  }
}
