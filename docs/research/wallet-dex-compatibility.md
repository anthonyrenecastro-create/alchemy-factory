# Token-2022 Extension Support: Wallet & DEX Compatibility Research

**Research date:** 2026-09-27 (all sources accessed 2026-09-27 unless vintage is stated)
**Method:** `browser.search` + `browser.open` on public web sources. No wallet or DEX was operated hands-on; claims are sourced, not tested.
**Vintage convention:** sources older than ~90 days are labeled `(vintage: <approx date>)` and flagged where newer confirmation could not be found.

> Honesty note (per `../STAGES.md`): this document reports what the ecosystem *claims or documents* about Token-2022 support. It is not itself a test result. Any extension combination intended for a real Alchemy Factory mint must still be verified against devnet/mainnet behavior before claims are made in the studio UI.

---

## 1. Wallets — Phantom, Solflare, Backpack

### 1.1 Phantom

- Phantom's official developer docs include a dedicated **"Token Extensions (Token22)"** page under its Solana powertools, and its Solana provider advertises Token-2022 extension support (alongside versioned transactions, priority fees, Actions & Blinks). ([api-evangelist/phantom repo index, updated 2026-05-24](https://github.com/api-evangelist/phantom))
- A wallet-compatibility matrix compiled for an RWA tokenization project (~April 2026, **vintage**) rates Phantom as **Full** Token-2022 support: transfer fees are shown on the transaction confirmation screen, frozen accounts display "with explanation", on-chain metadata is read (Metaplex schema), and Ledger works via blind signing. ([cipherion-market-research/abacus-trading-view — RWA_TOKEN_PLATFORM_ADDENDUM.md](https://github.com/cipherion-market-research/abacus-trading-view/blob/HEAD/plans/RWA_TOKEN_PLATFORM_ADDENDUM.md))
- An April 2026 Token-2022 vs SPL guide (**vintage**, but consistent with 2026 sources) states: *"Both [Phantom and Solflare] support Token-2022 fully, including the extensions UI. The 'Token-2022 doesn't work in wallets' story is from 2023 and outdated."* ([solfoundry.io/blog/token-2022-vs-spl](https://solfoundry.io/blog/token-2022-vs-spl))
- Phantom's in-wallet swaps route through the **Jupiter aggregator** (so Phantom swap behavior for extension tokens inherits Jupiter's routing behavior — see §2.1). ([xgram.io — Best Solana Wallets in 2026, 4 days old](https://xgram.io/blog/best-solana-wallets-in-2026-hot-cold-and-multi-chain-compared))

### 1.2 Solflare

- Solflare is consistently described in 2026 sources as having **full Token Extensions compatibility** (xgram.io wallet roundup, crawled <1 day before research). ([xgram.io](https://xgram.io/blog/best-solana-wallets-in-2026-hot-cold-and-multi-chain-compared))
- The April 2026 compatibility matrix (**vintage**) rates Solflare **Full**: its "Shield" transaction preview shows transfer-fee deductions before signing, frozen accounts display with explanation, and it works with Ledger/Keystone hardware. ([cipherion-market-research/abacus-trading-view](https://github.com/cipherion-market-research/abacus-trading-view/blob/HEAD/plans/RWA_TOKEN_PLATFORM_ADDENDUM.md))
- Solflare ships its own "Privacy Aggregator" / **Private Send** feature (launched Feb 2026). Important distinction: this is a **Houdini-based off-chain privacy provider**, not native Token-2022 confidential transfers — the on-chain link is hidden but the amount remains visible. Do not cite it as evidence of native confidential-transfer wallet UX. ([solflare.com — Privacy on Solana, Feb 2026](https://www.solflare.com/blog/introducing-solflare-privacy-aggregator-private-send/))

### 1.3 Backpack

- Backpack is the earliest documented Token-2022 wallet adopter: a May 2024 Helius overview (**vintage: May 2024**) already noted Backpack had added Token Extensions support. ([helius.dev/blog/what-is-token-2022](https://www.helius.dev/blog/what-is-token-2022))
- The April 2026 matrix (**vintage**) lists Backpack as **Supported** but "less documented" on transfer-fee handling, frozen display "likely", metadata yes. ([cipherion-market-research/abacus-trading-view](https://github.com/cipherion-market-research/abacus-trading-view/blob/HEAD/plans/RWA_TOKEN_PLATFORM_ADDENDUM.md))
- **No 2026-dated source found that details Backpack's per-extension behavior** (fee previews, hook handling, confidential accounts). For the studio: treat Backpack as "basic Token-2022 balances display, extension edge behavior unverified."

### 1.4 Extension-by-extension wallet behavior (as documented)

| Extension | Phantom | Solflare | Backpack | Notes |
|---|---|---|---|---|
| Plain Token-2022 (metadata only) | Full | Full | Supported | Displays like SPL tokens; metadata read on-chain. |
| Transfer Fee | Shown on confirmation screen | Shield previews deductions | "Less documented" (vintage) | Wallets do **not** absorb the fee in quotes — fee reduces the delivered amount on every transfer regardless of app. |
| DefaultAccountState=Frozen | Displays frozen "with explanation" | Displays frozen "with explanation" | Likely (vintage) | Transfers fail with `AccountFrozen (0x11)` until the freeze authority thaws. Requires extra user step, not silent. |
| Non-Transferable | No wallet-specific docs found | No wallet-specific docs found | No wallet-specific docs found | Transfers fail by design (except to/from mint authority). |
| Transfer Hook | No wallet-specific docs found | No wallet-specific docs found | No wallet-specific docs found | Hook executes on any transfer the wallet builds; if hook accounts aren't supplied, transfers fail. Wallet swaps for hook tokens route via Jupiter — see §2.1. |
| Permanent Delegate | No wallet-specific docs found | No wallet-specific docs found | No wallet-specific docs found | The delegate can move anyone's tokens at any time; this is a custody red flag, not a display issue. |
| Interest-Bearing | No docs on whether displayed balance is scaled | No docs on whether displayed balance is scaled | No docs found | **Undocumented.** Presumption that wallets show the raw balance (which understates the redeemable amount) is plausible but unverified — label as such, do not assert. |
| Confidential Transfers | No docs found | No docs found | No docs found | Native confidential transfers were **re-enabled on mainnet at epoch 982 (~Sept 9, 2026)** after a security-audit pause; the extension is mint-level opt-in at creation and cannot be added later. The wallet must keep an ElGamal keypair + AES key per account and manage pending/available balances. **No 2026 source found documenting any of the three wallets' UI for configuring confidential accounts or viewing encrypted balances — treat as unsupported-by-default in the studio.** ([dev.to — Confidential Transfers on Solana, Sept 2026](https://dev.to/sulimanmukhtar/confidential-transfers-on-solana-whats-native-whats-helius-rings-and-whats-actually-on-mainnet-329p)) |
| MemoTransfer (memo required) | No docs found | No docs found | No docs found | **Undocumented** for wallets. (Orca Whirlpools handles it via V2 instructions — §2.3.) |
| MintCloseAuthority | No docs found | No docs found | No docs found | No reported display issues. |

---

## 2. DEX / Aggregators — Jupiter, Raydium, Orca

### 2.1 Jupiter (the main aggregator)

- **Instant swaps:** Jupiter routes Token-2022 assets "when the specific mint, its extensions, and available liquidity are compatible with the selected execution path. A returned quote is the practical confirmation that an instant route exists. Transfer-fee and transfer-hook extensions alter transaction construction or received output, while some separate order products exclude Token-2022 tokens with transfer-tax features even when an instant swap route is available." ([jupiterdex.gr.com — third-party Jupiter swap guide, ~July 2026, not an official Jupiter source](https://jupiterdex.gr.com/))
- **Transfer hooks specifically:** no official Jupiter allowlist/blocklist for transfer-hook mints was found. Multiple independent 2026 sources converge on the same practical warning:
  - "Hook tokens often can't be routed by aggregators, which makes them untradeable" ([solfoundry.io, April 2026, vintage](https://solfoundry.io/blog/token-2022-vs-spl))
  - "The problem is that every protocol downstream of the token needs to know how to invoke the hook with the right accounts, which makes transfer-hooked tokens incompatible with most existing infrastructure" ([redduck-academy, 15 days old](https://github.com/redduckteam/redduck-academy/blob/HEAD/content/development-on-solana/working-with-other-programs/token-2022-and-token-extensions.md))
  - Raydium's security docs advise: "aggregators should skip transfer-hook mints by default and allow-list only verified hooks" ([raydium-io/raydium-docs-v1 — security/attack-vectors.mdx, updated ~Sept 19 2026](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/security/attack-vectors.mdx))
  - Rescue/bot tooling notes that unknown hook programs cause `MissingAccount` failures because the swap must resolve hook extra accounts via `ExtraAccountMetaList` ([nirholas/atomic rescue tutorial, 8 days old](https://github.com/nirholas/atomic/blob/HEAD/tutorials/04-rescue-tokens-leaked-key.md); [aran-tm/solana-tx-debugger — spl-token-errors.md, 67 days old](https://github.com/aran-tm/solana-tx-debugger/blob/HEAD/skill/spl-token-errors.md))
- **Integrator surface:** Jupiter's Metis swap guide (6 days old) documents error 6014 `IncorrectTokenProgramID` — "Attempted platform fees on a Token2022 token without `instructionVersion=V2`" — i.e., integrators must pass `instructionVersion=V2` for Token-2022 platform fees. ([jup-ag/docs — how-to-build-a-custom-swap-with-metis.mdx](https://github.com/jup-ag/docs/blob/HEAD/guides/how-to-build-a-custom-swap-with-metis.mdx))
- **Recurring/DCA orders: Token-2022 is NOT supported.** Stated in Jupiter's recurring best-practices docs and repeated across 2026 integrator skill files. ([perplexiphone-cmd/agent-skills, 11 days old](https://github.com/perplexiphone-cmd/agent-skills/blob/HEAD/.plugins/integrate-jupiter/codex/skills/integrating-jupiter/SKILL.md); [solanabr/skills, 5 days old](https://github.com/solanabr/skills/blob/HEAD/src/data/eco-skill-files/jupiter/integrating-jupiter/SKILL.md); [b-bhu/myboon, 2 days old](https://github.com/b-bhu/myboon/blob/HEAD/docs/tutorials/05-jup-llms.md))
- **Limit orders (Trigger):** no 2026 source found explicitly confirming or denying Token-2022 support; do not claim either way.
- **Jupiter Studio (their launchpad):** launches via Meteora DBC pools; the documented create-token flow does not advertise Token-2022 extension options for launched tokens (extensions covered in this doc are a creator-side choice, not a Studio default). ([jup-ag/docs — studio/create-token.mdx, 10 days old](https://github.com/jup-ag/docs/blob/HEAD/docs/studio/create-token.mdx))
- **No published Jupiter Token-2022 allowlist/blocklist** was found; per-mint behavior is determined by whether a quote returns.

### 2.2 Raydium (docs updated ~Sept 19, 2026 — among the freshest sources found)

Raydium is "one of the first major DEXes to natively support Token-2022" ([ecosystem-position.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/introduction/ecosystem-position.mdx)):

- **Support matrix:** **CPMM** supports Token-2022 fully (transfer fees, hooks, confidential transfers). **CLMM** supports transfer fees via explicit `SwapV2` accounts and hooks via `SwapV2`. **AMM v4 does not support Token-2022 at all.** LaunchLab has a dedicated `InitializeWithToken2022` entrypoint (optionally attaching `TransferFeeConfig`); Farm v6 supports Token-2022 on staking and reward mints. ([algorithms/token-2022-transfer-fees.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx); [protocol-overview/versions-and-migration.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/protocol-overview/versions-and-migration.mdx))
- **Transfer fees:** CPMM/CLMM compute the fee in/out of the curve math (fee reduces `amount_in` before the curve and `amount_out` after); slippage bounds are checked on the gross sent amount, "how every major Solana DEX handles Token-2022". UIs should subtract the expected fee when showing "You receive". ([algorithms/token-2022-transfer-fees.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx))
- **Transfer hooks:** CPMM forwards hook accounts in the swap instruction (extra CU overhead; hook must be "well-behaved"); **the Raydium UI flags pools with transfer-hook mints**. Documented abuse vector: hooks are upgradeable, so a malicious issuer could upgrade a hook to block transfers after attracting LP ("soft rug"); the program cannot prevent this mechanically. ([algorithms/token-2022-transfer-fees.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx); [security/attack-vectors.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/security/attack-vectors.mdx))
- **Non-transferable mints: `CreatePool` rejects them at init** — they cannot be LP'd at all. ([algorithms/token-2022-transfer-fees.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx))
- **Permanent-delegate mints are blocked** from pools (same statement as non-transferable in the ecosystem overview). ([introduction/ecosystem-position.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/introduction/ecosystem-position.mdx))
- **Interest-bearing mints:** pools read raw vault balances (ignoring accrual), so LPs effectively capture accrued interest as a "pure gift" on redeem — documented as benign but worth disclosing. ([algorithms/token-2022-transfer-fees.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx))
- **Wallet-facing note:** Raydium's FAQ warns "don't close Token-2022 accounts with transfer hooks (hook program runs on close)" — rent-reclamation flows must account for hooks. ([getting-started/faq.mdx](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/getting-started/faq.mdx))

### 2.3 Orca (Whirlpools — extension docs updated ~Sept 10, 2026)

Whirlpools has supported TokenExtensions since May 2024; all Token-2022 interactions go through **V2 instructions** (V1 instructions do not work for Token-2022 pools). Published extension list ([jup-ag/whirlpools — docs/02-Architecture Overview/07-TokenExtensions Support.md](https://github.com/jup-ag/whirlpools/blob/HEAD/docs/whirlpool/docs/02-Architecture%20Overview/07-TokenExtensions%20Support.md)):

- **Supported outright:** TransferFee, InterestBearing (since Oct 2024), MemoTransfer, MetadataPointer, TokenMetadata, ConfidentialTransfer (**non-confidential transfers only** — the encrypted mode is not usable in pools).
- **Supported only with an initialized TokenBadge (allowlist):** PermanentDelegate, TransferHook, MintCloseAuthority, DefaultAccountState (default state must be Initialized). Freeze authority also requires a TokenBadge and "should be disabled unless there is a reasonable reason".
- **Not supported:** Group, GroupPointer, Member, MemberPointer, **NonTransferable**, and all other extensions.
- Two-hop swaps were redesigned (V2) to transfer directly pool-to-pool to reduce transfer-fee overhead.

This is the closest thing the ecosystem has to a published **allowlist model** for Token-2022: risky extensions (hooks, permanent delegate, mint close, freeze, default-frozen) require a per-mint TokenBadge granted by Orca's badge authority.

### 2.4 Meteora (bonus — relevant because Jupiter Studio graduates tokens to Meteora)

Meteora's Presale Vault (docs 4 days old) accepts Token-2022 mints with **only** these mint extensions: `TransferFeeConfig`, `MetadataPointer`, `TokenMetadata`, `TransferHook`; any other extension fails validation (`UnsupportedToken2022MintOrExtension`). Transfer hooks are passed hook accounts; the hook program does not need to be revoked. ([meteoraag/docs — helper-products/presale-vault/token-2022-support.mdx](https://github.com/meteoraag/docs/blob/HEAD/helper-products/presale-vault/token-2022-support.mdx))

---

## 3. General 2026 ecosystem state: first-class, or still gaps?

**Substantially matured, but not first-class.** The trajectory 2024→2026 is real:

- Raydium CPMM/CLMM, Orca Whirlpools (V2), Meteora vaults, and Jupiter's router all handle Token-2022 in their current programs; Phantom/Solflare/Backpack all display Token-2022 balances; the April 2024-era Jupiter audit finding that transfer fees break exact-out calculations was fixed at the time (**vintage: April 2024 audit excerpt** — historical only). 
- RWA-scale adoption exists (BlackRock/Franklin Templeton/Ondo tokens on Solana, per the April 2026 RWA addendum, **vintage**) — but those are *permissioned* mints with curated custody, not evidence of permissionless DeFi composability.

**Significant gaps remain**, confirmed by September 2026 sources:

1. **Transfer hooks are still the composability cliff.** Every downstream program must supply hook accounts; aggregators are advised to skip hook mints by default; hook tokens "often can't be routed by aggregators". ([redduck-academy](https://github.com/redduckteam/redduck-academy/blob/HEAD/content/development-on-solana/working-with-other-programs/token-2022-and-token-extensions.md); [raydium security docs](https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/security/attack-vectors.mdx); [solfoundry.io](https://solfoundry.io/blog/token-2022-vs-spl))
2. **Jupiter's own order products exclude Token-2022** (Recurring/DCA) — the flagship aggregator does not treat Token-2022 as equal across its product surface.
3. **Allowlist/blocklist handling is venue-by-venue, not standardized:** Orca's TokenBadge, Raydium's UI flagging + pool-init rejection, Jupiter's silent quote-or-no-quote. There is no ecosystem-wide registry.
4. **Wallet behavior for the exotic extensions is undocumented:** confidential-transfer account UX, interest-bearing display scaling, memo-required enforcement, hook-transfer construction — none of the three wallets publish per-extension behavior.
5. **Builder consensus still hedges:** the Metaplex developer hub (3 days old) states "ecosystem support for Token-2022 is still maturing — most wallets, marketplaces, and DeFi protocols are optimized for the original Token Program"; a 52-day-old launchpad guide deliberately ships classic SPL for "the broadest wallet, explorer, and DEX support today". ([metaplex-foundation/developer-hub](https://github.com/metaplex-foundation/developer-hub/blob/HEAD/src/pages/en/solana/spl-tokens-and-token-programs.md); [dianehabonimana535-pixel/solmint-launchpad](https://github.com/dianehabonimana535-pixel/solmint-launchpad))

**One-line verdict for the studio:** plain Token-2022 (metadata, optional transfer fee) is effectively first-class in wallets and major DEXes; anything beyond that is a compatibility decision with venue-specific consequences.

---

## 4. Practical guidance for Alchemy Factory (Stage 2 compatibility checker)

Use this as the severity model for the studio's extension-combination warnings. "Hard warning" = block-by-default in the UI with explicit user acknowledgment required.

### 4.1 🟢 Safest — "will remain swappable and visible"

- **Token-2022 with MetadataPointer + TokenMetadata only.** Displays in Phantom/Solflare/Backpack; no transfer-time surprises; routes on Jupiter; LP-able on Raydium CPMM/CLMM and Orca Whirlpools without any badge.
- **+ MintCloseAuthority** (revocable) — no documented wallet/DEX issues; only affects the mint account itself.
- **+ ImmutableOwner on accounts** — inert; no documented issues.

### 4.2 🟡 Tradeable with caveats — warn, show the math

- **TransferFee (alone, no hook):** routes on Jupiter (quote = confirmation), works on Raydium CPMM/CLMM and Orca (no badge needed), accepted by Meteora vaults. **Caveats to surface:** (a) every transfer delivers less than sent — fee is withheld on the *recipient* account and harvested by the withdraw authority; (b) the fee authority can change the rate across an epoch boundary, so quoted "you receive" can drift; (c) Jupiter Recurring/DCA will not accept the token; (d) slippage bounds in DEX UIs are checked on gross, not net. Fee changes and max-fee caps are the main foot-gun.
- **InterestBearing (alone):** LP-able on Raydium and Orca, but **warn:** (a) no wallet documents showing the scaled balance — holders may see the raw amount; (b) Raydium pools read raw vault balances, so accrued interest leaks to LPs on redeem. Fine for a savings-vault mechanic, bad for a token whose price depends on displayed supply.

### 4.3 🔴 Hard warnings — require explicit acknowledgment in the studio

- **TransferHook (any combination):** 🔴 **strongest warning.** Breaks aggregator routing in practice (Jupiter quotes may simply not return); every integrator must pass hook extra accounts; adds CU overhead; Raydium flags hook pools in its UI; hook programs are **upgradeable** — a malicious or buggy upgrade can freeze all transfers (documented soft-rug vector); account-close flows also trigger the hook. If the mechanic truly needs a hook (e.g., compliance gating), the studio must disclose: "this token may not be swappable on Jupiter/Phantom swap; liquidity venues will treat it as restricted."
- **TransferHook + TransferFee:** treat as 🔴🔴 — the two most integration-hostile extensions stacked.
- **PermanentDelegate:** 🔴. Custody red flag ("can block or steal your sell"); blocked from Raydium pools entirely; Orca requires a TokenBadge. If a mechanic needs admin recovery powers, the studio must label the delegate authority and its holder prominently — never silently enabled (this matches the standing non-claim in STAGES.md).
- **NonTransferable:** 🔴/blocked. Cannot be LP'd on Raydium or Orca at all; only the mint authority can move tokens. Appropriate only for soulbound/badge mechanics where non-swappability is the *point* — the studio should confirm the creator understands the token will never trade.
- **ConfidentialTransfer:** 🔴. Re-enabled on mainnet Sept 2026, but **no wallet documents UI support** for configuring confidential accounts or viewing encrypted balances; Orca only supports the non-confidential path in pools; Raydium CPMM nominally supports it but pool UX is undocumented; transfers are 48-bit-capped and CU-heavy, with a pending/available two-step balance model. Do not offer as a one-click extension until a wallet documents support.
- **DefaultAccountState=Frozen:** 🟡→🔴 depending on thaw flow. Transfers fail (`AccountFrozen`) until thawed by the freeze authority; wallets display the frozen state but every holder needs an extra thaw step. Only appropriate with an automated thaw/onboarding flow, and the freeze authority holder must be disclosed.
- **MemoTransfer (memo-required):** 🟡. Orca handles it; wallet enforcement undocumented; every transfer must carry a memo or it fails — warn that plain wallet sends may fail.

### 4.4 Quick rule of thumb for the checker

> If it changes what a *transfer does* (hook, fee, freeze, memo, confidential), it changes what every wallet, router, and pool must do — and most of them handle it unevenly or not at all. If it only changes what a *mint says about itself* (metadata, close authority), it's safe.

---

## 5. Sources (all accessed 2026-09-27)

**DEX / aggregator docs (Sept 2026):**
- Raydium — Token-2022 transfer fees in swaps (docs updated ~Sept 19, 2026): https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/algorithms/token-2022-transfer-fees.mdx
- Raydium — attack vectors: transfer-hook abuse (docs updated ~Sept 19, 2026): https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/security/attack-vectors.mdx
- Raydium — ecosystem position / Token-2022 (docs updated ~Sept 19, 2026): https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/introduction/ecosystem-position.mdx
- Raydium — versions & migration: CPMM vs AMM v4 Token-2022 (docs updated ~Sept 19, 2026): https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/protocol-overview/versions-and-migration.mdx
- Raydium — FAQ: closing Token-2022 accounts with hooks (docs updated ~Sept 19, 2026): https://github.com/raydium-io/raydium-docs-v1/blob/HEAD/getting-started/faq.mdx
- Orca Whirlpools — TokenExtensions Support list + V2 instructions (docs updated ~Sept 10, 2026): https://github.com/jup-ag/whirlpools/blob/HEAD/docs/whirlpool/docs/02-Architecture%20Overview/07-TokenExtensions%20Support.md
- Meteora — Presale Vault Token-2022 support (docs updated 4 days ago): https://github.com/meteoraag/docs/blob/HEAD/helper-products/presale-vault/token-2022-support.mdx
- Jupiter — custom-swap-with-Metis guide: `IncorrectTokenProgramID` / `instructionVersion=V2` (6 days old): https://github.com/jup-ag/docs/blob/HEAD/guides/how-to-build-a-custom-swap-with-metis.mdx
- Jupiter — Studio create-token (10 days old): https://github.com/jup-ag/docs/blob/HEAD/docs/studio/create-token.mdx
- Jupiter Recurring (DCA) excludes Token-2022 — via integrator skill files (2–11 days old): https://github.com/b-bhu/myboon/blob/HEAD/docs/tutorials/05-jup-llms.md · https://github.com/solanabr/skills/blob/HEAD/src/data/eco-skill-files/jupiter/integrating-jupiter/SKILL.md · https://github.com/perplexiphone-cmd/agent-skills/blob/HEAD/.plugins/integrate-jupiter/codex/skills/integrating-jupiter/SKILL.md
- Jupiter swap behavior for Token-2022 (third-party guide, ~July 2026, not official): https://jupiterdex.gr.com/

**Wallet sources:**
- Phantom developer docs index — Token Extensions (Token22) page (repo updated 2026-05-24): https://github.com/api-evangelist/phantom
- 2026 wallet roundup: Phantom swaps via Jupiter; Solflare "full Token Extensions compatibility" (4 days old): https://xgram.io/blog/best-solana-wallets-in-2026-hot-cold-and-multi-chain-compared
- RWA wallet compatibility matrix: Phantom/Solflare full, Backpack supported, Trust Wallet unconfirmed (**vintage: ~April 2026**): https://github.com/cipherion-market-research/abacus-trading-view/blob/HEAD/plans/RWA_TOKEN_PLATFORM_ADDENDUM.md
- Solflare Private Send / Privacy Aggregator is Houdini-based, not native confidential transfers (Feb 2026): https://www.solflare.com/blog/introducing-solflare-privacy-aggregator-private-send/

**Ecosystem state / guides:**
- Metaplex developer hub: Token-2022 support "still maturing" (3 days old): https://github.com/metaplex-foundation/developer-hub/blob/HEAD/src/pages/en/solana/spl-tokens-and-token-programs.md
- Redduck Academy: transfer hooks "incompatible with most existing infrastructure" (15 days old): https://github.com/redduckteam/redduck-academy/blob/HEAD/content/development-on-solana/working-with-other-programs/token-2022-and-token-extensions.md
- SolFoundry: Token-2022 vs SPL in 2026 — wallet support, hook routing warning (**vintage: ~April 2026**): https://solfoundry.io/blog/token-2022-vs-spl
- SolMint launchpad: chose classic SPL for broadest support (52 days old): https://github.com/dianehabonimana535-pixel/solmint-launchpad
- solana-tx-debugger: Token-2022 gotchas — fees, hooks, frozen, ATA derivation (67 days old): https://github.com/aran-tm/solana-tx-debugger/blob/HEAD/skill/spl-token-errors.md
- Token rescue tutorial: hook extra accounts / MissingAccount failures (8 days old): https://github.com/nirholas/atomic/blob/HEAD/tutorials/04-rescue-tokens-leaked-key.md
- Confidential transfers re-enabled mainnet epoch 982 (~Sept 9, 2026) after audit pause; mechanics (ElGamal keys, pending/available, 48-bit cap) (Sept 2026): https://dev.to/sulimanmukhtar/confidential-transfers-on-solana-whats-native-whats-helius-rings-and-whats-actually-on-mainnet-329p
- Helius "What is Token-2022" — early wallet adoption note (**vintage: May 2024**): https://www.helius.dev/blog/what-is-token-2022
- Jupiter v4 audit excerpt: Token-2022/exact-out transfer-fee issue, fixed (**vintage: ~April 2024**; historical only): https://jupiter-space-station-jf9i2yvmk-wowcats.vercel.app (search-result text; no stable page URL returned)

**Not found (documented as gaps, not asserted):** any wallet's UI behavior for confidential-transfer accounts, interest-bearing balance display, memo-required enforcement, or hook-transfer construction; any official Jupiter transfer-hook allowlist/blocklist; Jupiter Trigger/limit-order Token-2022 support statement.
