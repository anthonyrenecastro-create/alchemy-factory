# Token-2022 Extension Recommendations per Mechanic Family

**Research date:** 2026-09-27
**Status:** research only — no claims about the project's own mints beyond what is evidenced here.
**Scope:** six Alchemy Factory mechanic families (see `docs/STAGES.md` for the project's honesty rules: claims never exceed evidence).

## Method and vintage notes

- The Token-2022 extension list and the **five protocol-enforced combination rules** are derived from the
  program source (`solana-program/token-2022`, `interface/src/extension/mod.rs`, commit `426400f`, dated
  2026-08-17), as walked through in the Solana BR academy course lesson "Classic SPL vs Token-2022:
  the decision framework + the conflict matrix" (lesson material current ~Sep 2026). Source-derived
  rules beat doc-page claims; where docs disagree with the source, this report says so.
  (https://github.com/solanabr/academy-courses/blob/HEAD/courses/digital-assets/lessons/m01-l4-decision-framework-conflict-matrix/intro.md — accessed 2026-09-27)
- Official extension behavior: the Token-2022 extension guide at
  https://www.solana-program.com/docs/token-2022/extensions (accessed 2026-09-27).
- DEX/wallet stances carry explicit vintage labels. "As of 2026" claims are only made where a
  2026-dated source was found; older or third-party material is labeled as such.

## The five protocol-enforced combination rules (init-time, `TokenError::InvalidExtensionCombination`)

These are the ONLY combinations the program rejects at mint initialization. Everything else is legal
to initialize (but may be rejected by venues — see the compatibility section).

1. `ConfidentialTransferFeeConfig` requires **both** `TransferFeeConfig` **and** `ConfidentialTransferMint`.
2. `TransferFeeConfig` + `ConfidentialTransferMint` together **require** `ConfidentialTransferFeeConfig`
   (the set is incomplete, not contradictory — adding the third extension fixes it).
3. `ConfidentialMintBurn` requires `ConfidentialTransferMint`.
4. `ScaledUiAmount` + `InterestBearingConfig` are **mutually exclusive** — the one true mutual exclusion
   in the matrix (both rewrite the displayed amount; the program refuses the ambiguity).
5. `NonTransferable` + `ConfidentialTransferMint` is invalid **unless** `ConfidentialMintBurn` is also present.

Source: same academy lesson above, quoting `check_for_invalid_mint_extension_combinations` verbatim.

**Docs-vs-code tension (important):** several doc pages (incl. Anchor's extension docs and a Sep-2026
compatibility writeup) claim `NonTransferable` + `TransferFeeConfig` cannot be combined. The five
enforced rules say nothing about that pair — it is a doc-level "makes no sense" caution, not an
init-time rejection. Do not rely on either claim: verify on devnet before shipping a design that
depends on it. (Same sources as above; https://medium.com/@SatoshiBro/solana-token-2022-extension-compatibility-explained-4cb6d018f469 — Sep 2026, third-party.)

## Forced account extensions (imposed at token-account creation)

From `required_init_account_extensions` in the same pinned source:

| Mint extension | Every holder account is forced to carry |
|---|---|
| `TransferFeeConfig` | `TransferFeeAmount` (per-holder withheld-fee storage) |
| `NonTransferable` | `NonTransferableAccount` **+** `ImmutableOwner` (closes the "transfer the account instead of the token" loophole) |
| `TransferHook` | `TransferHookAccount` |
| `Pausable` | `PausableAccount` |

Practical consequence: forced extensions are rent paid **per holder, forever** — size the account
budget when choosing extensions.

Also note: the Associated Token Program **always** sets `ImmutableOwner` on ATAs (official extension
guide) — that one costs you nothing and buys you protection against owner-reassignment tricks.

---

## Case 1 — Bonding-curve native token (program mints/burns, reserve vault, buy/sell fees)

### Recommended: MetadataPointer + TokenMetadata
- **What:** the mint designates its own account as the canonical metadata source (MetadataPointer),
  with name/symbol/URI stored on-chain in the mint (TokenMetadata). Update authority can be the curve
  program or a DAO key.
- **Why it fits:** the studio needs recognizable tokens without depending on Metaplex; this is the
  ecosystem-standard pattern (e.g. pump.fun Token-2022 mints carry exactly these two extensions —
  per a Sep-2026 burn-verification study of live mainnet mints:
  https://github.com/baseddev101/zcashmeme/blob/HEAD/docs/research/solana-burn.md).
- **Friction:** none meaningful. Raydium "fully allowed", Orca Whirlpools supported, Meteora DLMM
  permissionless, Phantom displays metadata (sources below).

### Recommended (optional): MintCloseAuthority
- **What:** allows the mint account itself to be closed and its rent reclaimed — **only when supply
  is 0** (official extension guide).
- **Why it fits:** a curve that fully unwinds (all supply burned) can be retired cleanly.
- **Friction:** Raydium's own docs disagree with each other at Sep-2026 vintage — the support reference
  page says mint-close-authority is "disallowed by default", while the fundamentals page lists it under
  "fully allowed". Treat as *uncertain for Raydium pools*; Orca requires a token badge.
  (https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/reference/token-2022-support.mdx and
  https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/solana-fundamentals/spl-token-and-token-2022.mdx — both accessed 2026-09-27.)

### Do NOT use TransferFeeConfig for buy/sell fees
- **What:** protocol-level fee in basis points on every transfer, withheld in the recipient's account
  (untouchable by the recipient) and harvestable by a designated withdraw authority; the fee authority
  can change the rate later (official extension guide).
- **Why it doesn't fit the curve's own fees:** (a) the extension fee applies to **transfers**, not to
  `MintTo`/`Burn` — the extension guide describes the fee as "assessed on every transfer" with fees
  "withheld on the recipient account"; buys/sells in this design are program mints/burns, so the
  curve's fee accounting stays in the program (as the Stage-1 tests already assume). (b) If enabled,
  sells (user → program vault) would withhold fees in the **program's own vault account**, requiring
  harvest transactions and delta-based accounting; a Sep-2026 auditor knowledge base flags exactly
  this class of bug — crediting the declared amount instead of the post-fee balance delta
  (https://github.com/solanabr/auditor-skill/blob/HEAD/known-vectors/105-token-2022-extension-abuse.md).
- **Friction if used for secondary-market fees:** moderate. Raydium CPMM supports transfer-fee mints
  via SwapV2 with fee-aware math (worked example in
  https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx,
  updated ~Sep 2026); Meteora DLMM accepts it permissionlessly; Orca Whirlpools supports it; Jupiter
  routes through compatible venues. Phantom displays fees (Apr-2026 vintage, see wallet table below).
  Transfers must use `transfer_checked`/`transfer_checked_with_fee`. **Verdict:** skip for Stage 1;
  revisit only if the design wants a secondary-transfer royalty, and then account on balance deltas.

### Rejected: TransferHook, PermanentDelegate, NonTransferable, InterestBearing/ScaledUiAmount, confidential suite
- **TransferHook:** the mint authority is already the curve program — a hook buys nothing and costs
  compute on every transfer plus venue friction (Raydium SwapV2-only "allowed with caveats"; Meteora
  requires a token badge for an active hook; Orca requires a badge).
- **PermanentDelegate:** an irrevocable authority that can transfer/burn anyone's balance; Raydium
  **blocks** pool creation for it; Orca requires a badge; it also bypasses CPI Guard (official guide)
  and fails against confidential balances. Pure downside here.
- **NonTransferable:** would kill the secondary market the curve exists to serve.
- **InterestBearing / ScaledUiAmount:** display-only cosmetics ("no new tokens are ever created" —
  official guide); the curve's price is real program math, not display math.
- **Confidential transfers (+ fee):** Raydium blocks confidential mints (pool math needs cleartext);
  Orca supports only non-confidential transfers; the ZK proof program was disabled Jun 2025–Jun 2026
  (re-enabled 2026-06-04 per a Sep-2026 third-party analysis:
  https://dev.to/sulimanmukhtar/confidential-transfers-have-a-kill-switch-what-it-costs-you-5h39).
  Reject for anything meant to trade.

---

## Case 2 — Time-decaying token (expiry + periodic decay; post-expiry transfer restrictions; privileged burn/rebase)

Real per-holder balance decay cannot be done natively without touching every account, so this case
combines a **display layer** with **transfer-time enforcement**.

### Recommended (pick exactly one): ScaledUiAmount XOR InterestBearingConfig
- **What:** both rewrite the *displayed* UI amount — `ScaledUiAmount` via an adjustable multiplier the
  multiplier authority can update (with an optional effective timestamp), `InterestBearingConfig` via a
  continuously-compounded rate from network time. Raw on-chain amounts never change; "entirely cosmetic"
  (official extension guide).
- **Why it fits:** a decay schedule maps naturally onto a decaying multiplier or a negative rate; the
  multiplier's effective-timestamp feature suits step decay.
- **Rule:** protocol-invalid to combine them (combination rule 4).
- **Friction / honesty caveats:** wallets/indexers must render the multiplier — verify on devnet that
  Phantom/Solflare display it (not confirmed by any source found; mark as unverified). Meteora's badge
  review path explicitly names "scaled UI amounts" as behavior affecting swaps. Because it is
  cosmetic, any redemption/settlement logic must use raw amounts — document the display/raw split in
  the UI (fits the STAGES.md honesty rules).

### Recommended: TransferHook (expiry + decay enforcement)
- **What:** the token program calls your hook program after every transfer's logic; the hook can
  enforce arbitrary rules (official guide; extra accounts auto-resolved on-chain, off-chain helpers in
  `spl-transfer-hook-interface`).
- **Why it fits:** block post-expiry transfers, enforce per-period decay settlement (e.g. require the
  program to have recorded the period's decay before a transfer clears). Note the hook is **not**
  called on self-transfers and — critically — `MintTo` does **not** fire the hook, so the decay
  program must guard the mint path itself (this gap is documented in a Sep-2026 RWA audit:
  https://github.com/devlab-group/rwa-platform-solana/blob/HEAD/solana/.audits/audit3.md).
- **Friction:** see Case 1 (Raydium SwapV2 caveats, Meteora/Orca badge). Higher CU per transfer;
  the hook program is a new audit surface.

### Recommended (optional): MintCloseAuthority + PermissionedBurn
- **MintCloseAuthority:** retire the mint once post-expiry burns drive supply to 0.
- **PermissionedBurn:** every burn needs the burn authority's co-signature; the regular
  `Burn`/`BurnChecked` instructions are rejected once the authority is set (official extension guide;
  also https://github.com/solanabr/academy-courses/blob/HEAD/courses/digital-assets/lessons/m02-l2-authority-extensions/intro.md — Sep 2026).
  This is the **scoped alternative to permanent delegate** for privileged decay burns: the authority
  can co-sign burns but cannot seize/transfer anyone's balance.

### Rejected: PermanentDelegate, NonTransferable (for this case), DefaultAccountState
- **PermanentDelegate** would enable true privileged burns, but it is the strongest trust assumption in
  the extension set (unlimited, irrevocable, bypasses CPI Guard), is blocked by Raydium, and needs
  badges elsewhere. Use PermissionedBurn instead.
- **NonTransferable** is the wrong tool for "restrictions after expiry" — it forbids *all* transfers
  (except to/from the mint authority, per Raydium's Sep-2026 docs), including the pre-expiry trading
  the token presumably needs. (For permanently non-transferable credentials, see Case 5.)
- **DefaultAccountState=frozen** would let the issuer freeze accounts at expiry, but it freezes *new*
  accounts too, requires a freeze authority to thaw, and Raydium blocks frozen-default mints
  (pool ATAs would land frozen). Clumsy versus a hook.

---

## Case 3 — Dynamic / oracle-fed token (metadata or supply changes from authenticated data)

### Recommended: MetadataPointer + TokenMetadata (update authority = the program/DAO)
- **What/why:** oracle-driven name/parameters/URI updates through the on-chain metadata the ecosystem
  already renders. Friction: none (see Case 1).

### Recommended: program-held mint authority (not an extension)
- **What:** supply changes (mint/burn) are signed by the curve/dynamic program after it verifies the
  oracle attestation (signature, freshness, publisher allow-list).
- **Why it fits:** no extension needed; mint authority is already a first-class concept. Remember:
  `MintTo` does not fire the transfer hook — all oracle validation must live in the program's mint
  instruction (Sep-2026 audit finding cited in Case 2).

### Optional: TransferHook for oracle-freshness gating
- **What:** reject transfers when the oracle data is stale (hook reads a freshness account).
- **Why it fits:** prevents trading on a dead feed without pausing the whole mint.
- **Friction:** same hook venue costs as Cases 1–2; adds a liveness dependency (if the oracle feed
  account can't update, transfers halt — fail-closed by design, but document it).

### Rejected: InterestBearing/ScaledUiAmount as the "dynamic" mechanism, PermanentDelegate, confidential suite
- If the oracle changes supply via real mints/burns, balances are already truthful — a display-only
  extension adds a second, cosmetic number that can confuse holders (and auditors). Only consider if
  the product explicitly wants display-level dynamism *without* supply changes, and then obey rule 4
  (exactly one).
- **PermanentDelegate:** unnecessary — mint authority covers supply; delegate adds seizure power nobody
  asked for and venue blocks.
- **Confidential suite:** combination rules 1–3 and 5 make this a minefield, and venues block it.

---

## Case 4 — Hierarchical / nested container (transferable container over a defined asset set)

Three structural options; the extension choice depends on whether the container must trade on DEXes.

### Option A — TokenGroup/GroupPointer + TokenMember/MemberPointer (declarative, native)
- **What:** the group extension stores collection config (update authority, max size) in a mint; the
  member extension stores group address + member number in each member mint; pointers designate the
  canonical accounts (official extension guide).
- **Friction — decisive:** Orca Whirlpools explicitly does **not** support Group/GroupPointer/
  Member/MemberPointer (Sep-2026 docs); Raydium lists group/member pointers as "not actively harmful,
  but unreviewed — disallowed by default" (Sep-2026 docs). **A grouped mint is effectively
  non-tradable on the two largest Solana DEXes today.** Fine if the container is program-managed and
  never pooled; disqualifying if it needs open liquidity.

### Option B — TransferHook + program-enforced composition (recommended if DEX liquidity matters)
- **What:** a plain fungible mint (MetadataPointer + TokenMetadata describing the basket) with a
  transfer hook that validates each transfer against the container's composition rules
  (membership list, weight bounds, rebalancing windows).
- **Why it fits:** keeps the token routable on hook-tolerant venues (Raydium CPMM/CLMM via SwapV2,
  "allowed with caveats"; Meteora/Orca via token badge), while composition logic stays upgradeable in
  the hook program rather than frozen in the mint's extension set.
- **Friction:** hook venue costs as in Case 1; the hook's extra accounts must be resolvable by every
  client (wallets resolve these for simple sends; aggregators need hook-aware routing — test on devnet).

### Option C — Off-token container (program account holds the set; separate share token)
- **What:** no Token-2022 grouping at all; the container is a program account, and the transferable
  instrument is a plain share token (Case 1 pattern).
- **Why it fits:** zero extension friction, maximum flexibility for dynamic membership; the share
  token stays maximally compatible.
- **Tradeoff:** composition is only visible via the program/indexer, not via native group primitives
  that explorers understand.

**Recommendation:** Option B if the container must be a single transferable token with on-chain rules;
Option C if membership churns or DEX compatibility is paramount; Option A only for
never-traded, program-managed containers (document the DEX exclusion).

---

## Case 5 — Proof-of-X minting (attestation-gated mint; restricted mint authority; soulbound-like behavior)

### Recommended: NonTransferable (+ forced NonTransferableAccount + ImmutableOwner)
- **What:** "soul-bound" tokens that cannot be moved to any other entity; transfers are rejected
  except to and from the mint authority (Raydium Sep-2026 docs:
  https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx);
  the owner can still burn and close the account (official extension guide). Every holder account is
  forced to carry `NonTransferableAccount` + `ImmutableOwner` (pinned source).
- **Why it fits:** attestation credentials usually must not be tradable; the mint authority (the
  Proof-of-X program) can still distribute by minting directly to recipients.
- **Friction:** absolute by design — Raydium blocks pool creation, Orca lists it as not supported,
  Meteora needs a badge. That is the point of soulbound; disclose it (STAGES.md: extensions are
  disclosed, never silently enabled).

### Recommended: PermissionedBurn (program PDA as burn authority) for revocation
- **What/why:** credentials often need issuer revocation. PermissionedBurn makes every burn require
  the burn authority's co-signature while granting **no** transfer/seizure power — the scoped
  alternative to PermanentDelegate (official extension guide; production pattern in Sep-2026 RWA
  work: https://github.com/devlab-group/rwa-platform-solana/blob/HEAD/solana/README.md and the
  Solana Foundation enterprise-training MMF example:
  https://github.com/solana-foundation/solana-enterprise-training/blob/HEAD/module-5-rwas-on-solana/examples/anchor-mmf/README.md).
- **Friction:** new extension (shipped in Token-2022 v11 / `spl-token-2022` 11, mid-2026); wallet
  support for the permissioned-burn instruction path is not documented in sources found — the
  program, not the wallet, will drive burns, so this is acceptable. Not in the five conflict guards:
  combines freely with NonTransferable.

### Recommended: MetadataPointer + TokenMetadata; optional MintCloseAuthority
- Credential schema (attestation type, issuer, expiry) on-chain; mint retirement when supply is 0.

### Rejected: PermanentDelegate, TransferHook, confidential suite, TransferFeeConfig
- **PermanentDelegate:** revocation does not require transfer power; the delegate's unlimited,
  irrevocable seizure authority (which bypasses CPI Guard per the official guide) is the wrong trust
  shape and is venue-blocked.
- **TransferHook:** technically combinable with NonTransferable (absent from the five guards), but a
  Sep-2026 writeup notes the combination "does not make practical sense" — there are no ordinary
  transfers for the hook to enhance (https://medium.com/@SatoshiBro/solana-token-2022-extension-compatibility-explained-4cb6d018f469).
- **Confidential suite:** rule 5 makes `NonTransferable` + `ConfidentialTransferMint` invalid without
  `ConfidentialMintBurn`; skip the whole suite — credentials need auditability, not encryption.
- **TransferFeeConfig:** no transfers, no fees (and the docs-vs-code tension on this pair in the
  introduction means it is not worth touching).

---

## Case 6 — Collateral vault share token (PAXG-collateralized experiment; share accounting; redemption; solvency)

### Recommended: MetadataPointer + TokenMetadata; program-enforced everything else
- **What:** the share token itself stays a **plain, maximally compatible mint** (metadata only).
  Share accounting, redemption pricing, withdrawal limits, and the `deposits >= claims` solvency
  invariant live in the vault program — exactly as STAGES.md Stage 3 specifies (program-tested
  invariants, off-chain calculated collateral value, never an on-chain price promise).
- **Why not more extensions:** every extension on the share mint is a claim about holder experience
  that must survive the honesty rules. Specifically rejected:
  - **InterestBearing:** display-only "yield" accrual would imply the automatic yield STAGES.md
    explicitly disclaims (PAXGy is a disabled research module). Do not ship a yield-looking number.
  - **ScaledUiAmount:** a cosmetic collateral-ratio multiplier risks being read as a guaranteed
    redemption value; the UI shows a *calculated* value off-chain instead.
  - **PermanentDelegate:** breaks the solvency invariant — a delegate can seize the vault's share
    accounts (the exact "custodied vault seizure" vector in the Sep-2026 auditor knowledge base:
    https://github.com/solanabr/auditor-skill/blob/HEAD/known-vectors/105-token-2022-extension-abuse.md);
    also venue-blocked.
  - **TransferFeeConfig:** redemption fees belong in the vault program's math; withheld fees would
    strand value in vault accounts and the fee authority could change the rate later.
  - **Confidential transfers:** solvency needs public auditability; venues block it.

### Optional (gated): TransferHook for redemption windows / allow-listing; PermissionedBurn for supply discipline
- **TransferHook** enforcing redemption windows or holder allow-lists is the one extension that can
  carry real compliance value here — at the usual hook venue cost (badge on Meteora/Orca, SwapV2
  caveats on Raydium).
- **PermissionedBurn** with the vault program as burn authority keeps on-chain supply an honest mirror
  of vault liabilities (no holder can unilaterally torch shares the vault's books still count) — the
  redemption-accounting pattern from the Sep-2026 RWA audit
  (https://github.com/devlab-group/rwa-platform-solana/blob/HEAD/solana/.audits/audit3.md).

### Required regardless: validate the *collateral* mint's extensions
- The vault must inspect any PAXG (or mock) mint it custodies and **reject hostile extension configs**
  — permanent delegate, frozen-default, unexpected transfer fees — or explicitly allow-list a vetted
  mint. This is the established pattern: a Sep-2026 RWA audit recommends `validate_quote_mint`
  rejecting every extension that changes transferred amounts, invokes code, or seizes balances
  (https://github.com/devlab-group/rwa-platform-solana/blob/HEAD/solana/.audits/audit3.md), and the
  auditor knowledge base's pass criterion is "allowlisted mints, or full extension inspection +
  delta-based accounting" (https://github.com/solanabr/auditor-skill/blob/HEAD/known-vectors/105-token-2022-extension-abuse.md).
  Real-world reference point: PayPal's PYUSD Solana mint carries permanent-delegate/transfer-fee
  extensions (per a Sep-2026 Chainstack doc:
  https://github.com/chainstack/dev-portal/blob/HEAD/docs/solana-subscriptions-and-allowances.mdx) —
  the vault must decide *before* mainnet whether it accepts that shape.
  **Stronger reference point (2026-09-27 correction): Paxos's own native Solana PAXG mint
  `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW` carries a permanent delegate, mint close
  authority, an inactive transfer hook (null program id), 0 bps transfer fee, and confidential
  transfers, with the same compliance authority key as Paxos's PYUSD/USDGP mints** (per a
  Solana DeFi developer's on-chain analysis:
  https://github.com/stabbleorg/anchor-common/commit/335539831d1f47a225871568db01067dd5fb7742;
  Solscan: https://solscan.io/token/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW).
  A "reject permanent delegate" default would therefore reject real PAXG itself — the
  vault's mainnet policy must be an explicit allow-list decision for this exact mint,
  with the seizure power disclosed to holders, not a blanket extension ban.

---

## Per-extension compatibility friction (as of 2026, vintage-labeled)

| Extension | Wallets (Phantom / Solflare / Backpack) | DEX / aggregators | Notes |
|---|---|---|---|
| TransferFeeConfig | Phantom displays fees (Apr-2026 RWA study — vintage 2026-04; re-verify) | Raydium CPMM: supported via SwapV2, fee-aware math (Sep 2026); Meteora DLMM: permissionless (Sep 2026); Orca Whirlpools: supported (since Oct 2024); Jupiter: routes via compatible venues (Oct-2025 news — vintage) | Requires `transfer_checked`; fee authority can change the rate — disclose |
| TransferHook | Simple sends resolve extra accounts via `spl-transfer-hook-interface` helpers; wallet behavior on exotic hooks unverified — test on devnet | Raydium: allowed with caveats, SwapV2 (Sep 2026); Meteora: permissionless only if hook program + authority revoked, else badge (Sep 2026); Orca: badge (Sep 2026) | CU overhead per transfer; hook is a new audit surface |
| PermanentDelegate | Wallets show warnings (Phantom "full incl. warnings", Apr-2026 vintage) | Raydium: **blocked** (Sep 2026); Orca/Meteora: badge-only | Irrevocable seizure power; bypasses CPI Guard (official guide) |
| MintCloseAuthority | No holder impact (mint-level; needs supply = 0) | Raydium docs conflict at Sep-2026 vintage (one page "disallowed by default", another "fully allowed"); Orca: badge | Flag the conflict; don't assume |
| MetadataPointer + TokenMetadata | Universal display support | Raydium fully allowed; Orca supported; Meteora permissionless | Baseline — include by default |
| DefaultAccountState (frozen) | Phantom displays frozen status (Apr-2026 vintage) | Raydium: **blocked**; Orca: badge, and default state must be Initialized (frozen default effectively unusable); subscription/payment rails reject | Only for permissioned/compliance tokens |
| ImmutableOwner | Automatic on all ATAs (official guide) — zero friction | n/a | Free protection; forced by NonTransferable |
| NonTransferable | Held/displayed; cannot be sent | Raydium/Orca: **blocked**; Meteora: badge | Soulbound by design; mint authority can still move tokens |
| InterestBearingConfig | Displayed as accruing (Apr-2026 vintage) | Orca supported (since Oct 2024); Raydium allowed but pool math reads raw balances (LPs capture accrual — Sep 2026) | **Cosmetic only** — no new tokens; never present as yield |
| ConfidentialTransfer (+ fee) | Uncertain; ZK proof infra required per account | Raydium: **blocked**; Orca: non-confidential transfers only | Disabled Jun 2025–Jun 2026, re-enabled 2026-06-04 (third-party analysis, vintage Sep 2026) — still effectively unroutable |
| CPI Guard | User opt-in per account | n/a (account-level) | Do NOT enable on program vault accounts (blocks the program's own owner-signed CPI transfers); permanent delegate bypasses it |
| MemoTransfer | Account-level opt-in; receiver-side wallet support unverified | Meteora DLMM handles it (Sep 2026) | Compliance-only use; test wallet UX on devnet |
| ScaledUiAmount | Wallet rendering unverified — test on devnet | Meteora badge path names it explicitly (Sep 2026) | **Cosmetic only**; mutually exclusive with InterestBearing (rule 4) |
| PermissionedBurn | Program-driven (no wallet path needed) | No venue data found (new in Token-2022 v11, mid-2026) | Scoped revocation without seizure power; combines freely |
| Pausable | Wallets show paused state (by analogy with frozen; unverified) | Rejected by payment/subscription rails; badge paths elsewhere | Global kill switch — heavy trust assumption; not recommended for these cases |

**Wallet/venue vintage summary:** DEX stances above are Sep-2026 (Raydium docs updated ~Sep 19 2026;
Orca Whirlpools docs ~Sep 10 2026; Meteora DLMM docs ~Sep 23 2026). Wallet claims (Phantom/Solflare/
Backpack/Trust Wallet, "do NOT send Token-2022 to CEX addresses") come from an RWA platform study
updated ~Apr 2026 — vintage 2026-04, re-verify before mainnet:
https://github.com/cipherion-market-research/abacus-trading-view/blob/HEAD/plans/RWA_TOKEN_PLATFORM_ADDENDUM.md.

**Key DEX sources (all accessed 2026-09-27):**
- https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/reference/token-2022-support.mdx
- https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/solana-fundamentals/spl-token-and-token-2022.mdx
- https://github.com/jup-ag/whirlpools/blob/HEAD/docs/whirlpool/docs/02-Architecture%20Overview/07-TokenExtensions%20Support.md
- https://github.com/meteoraag/docs/blob/HEAD/core-products/dlmm/token-2022-support.mdx

## Cannot-combine / caution pairs (consolidated)

- **Protocol-rejected (init-time):** the five rules in the introduction — only ScaledUiAmount ⊕
  InterestBearing is a true mutual exclusion; the rest are dependency/bridge rules around the
  confidential suite.
- **Docs claim, code does not enforce:** NonTransferable + TransferFeeConfig — verify on devnet;
  do not design around either claim.
- **Technically legal, practically pointless:** NonTransferable + TransferHook (no ordinary transfers
  for the hook to enhance).
- **Trust-shape conflicts:** PermanentDelegate + CPI Guard (delegate bypasses the guard — official
  guide); PermanentDelegate + any program-held vault (seizure breaks custody invariants).
- **Venue conflicts (policy, not protocol):** PermanentDelegate / NonTransferable / Confidential /
  frozen-DefaultAccountState are blocked or badge-gated on every major DEX — a mint can be
  init-legal yet unroutable ("legality is a floor, not routability").

## Open items for the Stage-2 compatibility checker (devnet verification needed)

1. NonTransferable + TransferFeeConfig: settle the docs-vs-code tension with an actual init attempt.
2. ScaledUiAmount rendering in Phantom/Solflare/Backpack; InterestBearing negative-rate display.
3. Wallet send UX for transfer-hook mints (extra-account resolution) and for memo-required receivers.
4. Transfer-fee harvest UX (`harvest_withheld_tokens_to_mint` discoverability) if a secondary fee is
   ever enabled.
5. Raydium's internal conflict on MintCloseAuthority (both readings are Sep-2026 vintage) — confirm
   with a test pool or their team before promising pool support.
6. Jupiter routing behavior for hook/fee mints end-to-end (Ultra v3 Token-2022 support is Oct-2025
   vintage news: https://www.theblock.co/news/defi/2025-10-17-solana-decentralized-exchange-aggregator-jupiter-unveils-ultra-v3-improved-trade-execution-mev-protections-gasless-support-375184
   — re-verify current behavior on devnet).
