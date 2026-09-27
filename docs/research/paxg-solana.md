# PAXG & PAXGy on Solana — research memo

**Research date:** 2026-09-27
**Project context:** Alchemy Factory stage-3 (PAXG collateral vault prototype on devnet)
**Honesty rule:** every material claim carries a source URL + access date. No mint address
appears in this file that is presented as official unless Paxos itself published it.
Third-party mint addresses are labeled **UNVERIFIED** explicitly.

---

## CORRECTION — 2026-09-27 (supersedes the "no official Solana mint" conclusion in A.1/A.3)

Paxos launched PAXG natively on Solana on **June 25, 2026**, announced via Paxos's
official X account and distributed through **Sunrise DeFi** (Wormhole's asset-onboarding
pipeline), with day-one trading on Jupiter, Raydium, Kamino, and Mayan. The Solana
deployment uses the **Token-2022** standard with compliance extensions.

**Native Solana PAXG mint (Paxos-issued):** `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`
- Solscan: https://solscan.io/token/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW
- Evidence chain — no single paxos.com page prints the address, so this is a
  convergence of independent sources, not a Paxos-published address:
  - Solflare (wallet): *"The official Solana contract address for PAX Gold is
    5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW"*, *"verified on Solana's token
    registry"*
    (https://www.solflare.com/prices/pax-gold/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW/, accessed 2026-09-27)
  - Jupiter token page: https://jup.ag/tokens/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW (accessed 2026-09-27)
  - Stabble (Solana DeFi developer, commit 2026-07-13): *"Paxos's native Solana PAXG
    mint"*; its extension profile matches Paxos's PYUSD/USDGP mints with the same
    compliance authority key
    (https://github.com/stabbleorg/anchor-common/commit/335539831d1f47a225871568db01067dd5fb7742, accessed 2026-09-27)
- **Extension profile of the native mint** (per the Stabble on-chain analysis):
  permanent delegate, mint close authority, inactive transfer hook (null program id),
  0 bps transfer fee, confidential transfers — same compliance authority key as Paxos's
  PYUSD and USDG. **Project implication: real PAXG carries a permanent delegate — an
  irrevocable seizure power. Any future real-PAXG vault integration must disclose this
  and must never present the token as permissionless.** This is the concrete real-world
  example behind the compat checker's red severity for permanent delegates.
- The OTHER circulating address, `C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe`, is
  **WPAXG** — a Wormhole-wrapped SPL token dated 2025-06-21 (a year *before* the native
  launch), per CoinDesk's platforms table and Solscan's own "Paxos Gold (Wormhole)"
  title. It is NOT the Paxos-issued native mint and must never be treated as such.

**What this changes for Alchemy Factory:**
- Stage 3 (devnet vault): **UNCHANGED** — still `MOCK-GOLD` only, strictly devnet.
  There is no official PAXG on devnet, and no devnet token may be labeled PAXG.
- Stage 4 (mainnet readiness): the "real PAXG assessment" now has a concrete candidate
  mint with a verified-registry trail — but integration stays gated on (a) direct Paxos
  confirmation of the mint address through an official Paxos channel, and (b) a threat
  model accounting for the permanent delegate + freeze/upgrade authority and the
  430-PAXG physical-redemption minimum.
- June-2026 announcement coverage:
  https://www.cryptotimes.io/2026/06/25/gold-goes-onchain-paxos-launches-paxg-on-solana/
  and https://solanacompass.com/news/paxos-brings-pax-gold-to-solana-via-sunrise-making-paxg-the-first-occ-regulated-gold-token-on-the-network
  (both accessed 2026-09-27); Paxos's own LinkedIn announcement:
  https://www.linkedin.com/posts/paxos_paxg-is-now-live-on-solana-via-sunrise-defi-activity-7475915292259426304-A-W8

---

## SECTION A — PAXG, from Paxos official documentation only

Sources: [Paxos PAX Gold product page](https://paxos.com/PAXGold) (accessed 2026-09-27)
and [PAX Gold Terms and Conditions](https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions)
(last modified December 12, 2025; accessed 2026-09-27).

### A.1 — Does PAXG exist natively on Solana? Official Solana mint address?

**What Paxos's own documentation says:** Paxos's official product page and legal terms
describe PAXG as an Ethereum/ERC20 token only:

- PAX Gold Terms and Conditions, §4.8: *"PAXG is an ERC20 token on the Ethereum public
  blockchain."*
  (https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions, accessed 2026-09-27)
- The paxos.com PAX Gold product page's allocation-lookup tool is described as
  *"for PAXG held in on-chain Ethereum wallets"* and all settlement copy refers to
  *"Pax Gold moving on Ethereum"*.
  (https://paxos.com/PAXGold, accessed 2026-09-27)

**Conclusion: Paxos publishes NO official Solana mint address on paxos.com.**
Neither the product page nor the PAX Gold Terms and Conditions list any Solana mint
address, and neither mentions Solana at all.

**What third-party reporting says (NOT official documentation):** multiple crypto-news
outlets report that Paxos expanded PAXG to Solana on **June 25, 2026**, as the first phase
of a multi-chain strategy, using the **Token-2022** standard, with the announcement made
via Paxos's official X account and distribution handled through **Sunrise DeFi**
(Wormhole's asset-onboarding pipeline), with day-one trading on Jupiter, Raydium, Kamino,
and Mayan.

- https://www.cryptotimes.io/2026/06/25/gold-goes-onchain-paxos-launches-paxg-on-solana/ (accessed 2026-09-27)
- https://solanacompass.com/news/paxos-brings-pax-gold-to-solana-via-sunrise-making-paxg-the-first-occ-regulated-gold-token-on-the-network (accessed 2026-09-27)
- https://www.tronweekly.com/paxos-expands-paxg-to-solana-as-demand/ (accessed 2026-09-27)
- Independently, Helius's Solana RWA overview states: *"PAXG expanded to Solana in June
  2026, where it is issued using Token-2022 with compliance controls built into the token.
  It can ultimately be redeemed through Paxos for physical bullion, unallocated gold,
  or USD."*
  (https://www.helius.dev/blog/solana-real-world-assets, accessed 2026-09-27)

**Mint addresses circulating online — UNVERIFIED third-party data, NOT official:**

- `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW` — claimed by a third-party DeFi
  integrator (stabbleorg) to be "Paxos's native Solana PAXG mint" (Token-2022; extension
  profile said to match Paxos's PYUSD/USDGP mints with the same compliance authority
  key). This was found in a code commit, **not** on any Paxos-owned domain.
  https://github.com/stabbleorg/anchor-common/commit/335539831d1f47a225871568db01067dd5fb7742
  (commit dated 2026-07-13; accessed 2026-09-27) — **treat as UNVERIFIED.**
- `C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe` — CoinDesk's token-platforms table lists
  this as **WPAXG** (wrapped PAXG) on Solana, dated 2025-06-21 — *a year before* the
  reported native June 2026 launch. This is consistent with an unofficial third-party
  wrapped token, not a Paxos-issued mint.
  https://www.coindesk.com/price/pax-gold/platforms (accessed 2026-09-27) — **treat as
  UNVERIFIED and likely non-native.**

The existence of an older, unofficial "wrapped" SPL token is precisely why the project
must not adopt a mint address from third-party listings: the only mint Paxos itself
documents is the Ethereum ERC20 contract.

### A.2 — Paxos's stated PAXG redemption policy (official terms)

From the PAX Gold Terms and Conditions (https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions,
accessed 2026-09-27):

- **Eligibility / KYC:** *"Only verified Customers may purchase PAXG from us or convert
  or redeem PAXG from us"* (§4.11). Customers must hold a Paxos Platform account; the
  terms reserve Paxos's right to refuse issuance/redemption on compliance or legal
  grounds. A non-zero account with no issuance/redemption activity for 12+ months incurs
  a $2.00/month inactivity charge (§15.5).
- **What you can redeem into:** (i) US dollars (§11.2); (ii) **unallocated** Loco London
  gold wired to your disclosed bullion account (§11.3); (iii) **allocated** London Good
  Delivery gold bars (§11.4).
- **Physical (allocated bar) minimum:** *"You must redeem a minimum of 430 PAXG tokens
  plus the fee set forth in the Paxos User Guide, per London Good Delivery gold bar"*
  (§11.4). The actual bar may weigh less than 430 fine troy ounces; excess tokens are
  credited back after Paxos determines the bar's exact weight. Paxos *may require
  additional due diligence* for allocated-gold redemption, and the customer is
  *responsible for arranging and paying for delivery* per Paxos's instructions.
- **Custody/ownership model:** each PAXG = one fine troy ounce of London Good Delivery
  gold; tokens represent *fractional ownership of gold bars held by Paxos Trust on a
  segregated basis for the benefit of PAXG holders within LBMA-approved security carrier
  vaults* (§4.2–4.3). Issuance is under Paxos Trust Company, N.A.'s specific OCC approval
  (§4.5, §4.6).
- **Fees:** conversion/redemption fees are defined in the Paxos User Guide / Pricing
  Supplement, incorporated by reference (§15.1). The fee schedule shown on the paxos.com
  PAX Gold product page appears stale (2020-dated reference values); third-party coverage
  reports Paxos updated direct redemption fees effective **September 1, 2026** to tiered
  marginal rates (0.125% on the first $2M of rolling 30-day net redemptions, 0.25% to
  $10M, 0.35% to $20M, 0.50% above $20M, plus a 0.05% in-kind fee for conversion into
  allocated/unallocated gold) — https://www.securities.io/investing-in-pax-gold/
  (accessed 2026-09-27). **Third-party, unconfirmed against the official fee schedule —
  check the live Paxos User Guide before quoting fees.**
- **Administrative controls disclosed by Paxos itself:** as part of the ERC20 contract,
  Paxos retains the ability to freeze and upgrade all PAXG tokens on an aggregate basis
  (§14.1), and must comply with legal directives to freeze/seize tokens or the backing
  gold (§14.2–14.5). Any mainnet collateral integration must disclose this custody/
  freeze risk rather than imply the token is permissionless.

### A.3 — Official Paxos statements about Solana plans / contract addresses

- **No official statement found on paxos.com.** The PAX Gold product page, Terms and
  Conditions (Dec 2025), white paper materials, and reserve-report pages found during
  this research do not mention Solana or publish Solana contract/mint addresses. A
  targeted search for a paxos.com-hosted Solana announcement returned no result
  (searched 2026-09-27). The only attributed source for the June 25, 2026 expansion is
  Paxos's official **X account** (per the third-party articles cited in A.1) — this could
  not be verified directly from this research environment, so it is reported as
  *third-party-attributed*, not confirmed official.
- **Chain coverage Paxos documents:** the official terms and product page describe
  Ethereum/ERC20 only. Third-party aggregators list additional deployments (e.g.,
  Ethereum `0x45804880de22913dafe09f4980848ece6ecbaf78`, Energi
  `0xbF8afa4663B30c621a5f7497a972Fc63c1a06c66` per
  https://www.coindesk.com/price/pax-gold/platforms, accessed 2026-09-27), but these are
  **not published by Paxos in the official sources reviewed** — they are repeated here
  only as third-party data and are not verified as Paxos-issued.

---

## SECTION B — PAXGy (yield-bearing Paxos gold token)

Primary source: Paxos Labs official announcement via PRNewswire, dated **September 24,
2026** — https://www.prnewswire.com/news-releases/paxos-labs-launches-paxgy-a-paxg-backed-token-that-grows-in-gold-terms-302888407.html
(accessed 2026-09-27). Secondary confirmation: https://www.newsbtc.com/altcoins/paxos-labs-launches-gold-token-that-can-earn-a-return-in-gold/
and https://cryptobriefing.com/paxos-labs-launches-paxgy-gold-yield-token/ (both accessed 2026-09-27).

### B.1 — Issuer, chains, Solana availability

- **Issuer:** **Paxos Labs** — described in the announcement as *"the enterprise-grade
  digital asset infrastructure provider… Incubated within Paxos and built on its
  $230B+ track record in tokenization"*. Note: Paxos Labs is distinct from **Paxos
  Trust Company, N.A.**, which issues PAXG itself (the announcement quotes Paxos Head
  of Strategy Walter Hessert saying *"As the issuer of PAXG…"*). The project must not
  describe PAXGy as issued by Paxos Trust Company.
- **Venue / chain availability at launch (per the official announcement):** live on
  **OKX** (only centralized exchange at launch, via OKX Gold Earn) and on-chain across
  **X Layer** (an Ethereum L2), **Uniswap**, **0x**, and **Ether.Fi**. **Chainlink CCIP**
  is the exclusive cross-chain messaging provider for moving PAXGy positions across
  supported chains without unwinding.
- **Solana availability: NO.** No Solana deployment, listing, or venue is mentioned in
  the official announcement or in any of the launch coverage reviewed. There is no
  evidence PAXGy exists on Solana.

### B.2 — Redemption mechanics, risks, terms (as stated by the issuer)

- **Mechanism:** PAXGy is *built on PAXG*; holders deposit PAXG (or swap accepted
  stablecoins) and receive PAXGy, whose value accrues through an **exchange rate
  denominated in gold terms** — the holder's token balance does not increase; instead
  each PAXGy becomes redeemable for *more PAXG over time*. The reserves backing PAXGy
  are *"deployed to a network of vetted institutional borrowers through the same
  leasing market that has set bullion lease rates for decades"* (refiners, jewelry
  manufacturers, miners, bullion banks, per Paxos Labs co-founder Bhau Kotecha).
- **Exit:** PAXGy is *"redeemable for PAXG at any time"* per the announcement; direct
  physical-gold redemption of the underlying PAXG then follows Paxos Trust Company's
  PAXG terms (verified account; 430-PAXG minimum + fee for allocated bars — see A.2).
- **Risks — stated explicitly by Paxos Labs:** *"A purchase of PAXGy involves credit,
  liquidity, and market risks. The asset accrues value by deploying its reserves into
  external strategies, but growth is not guaranteed; if these strategies suffer losses
  or borrower defaults, the exchange rate may be adjusted downward, potentially
  resulting in losses. Because PAXG and PAXGy are gold-tracking instruments, the fiat
  value of PAXGy holdings is exposed to the market volatility of physical gold."*
  The announcement also carries the standard "not an offer to sell" disclaimer and
  jurisdictional restrictions.
- **Terms pages:** the announcement points to https://paxgy.com and https://paxoslabs.com
  for additional information and terms. No on-chain contract addresses for PAXGy were
  published in the announcement.

### B.3 — Conclusion for Alchemy Factory stage-3

**Stage-3 must use a mock asset on devnet — it cannot use real PAXG on Solana.**

Evidence trail for this conclusion:

1. **Devnet has no official PAXG at all.** The only native Solana PAXG deployment
   reported anywhere is on Solana *mainnet* (June 25, 2026, per third-party reports;
   see A.1). No devnet deployment exists in any source reviewed.
2. **Superseded by the 2026-09-27 CORRECTION above:** the native Solana PAXG mint is now
   identified as `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW` (Token-2022, verified on
   Solana's token registry per Solflare, Jupiter-listed; Solscan:
   https://solscan.io/token/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW). Paxos's own
   site still does not print the address, so stage-4 integration remains gated on
   direct Paxos confirmation. The mint's extension profile (permanent delegate,
   confidential transfers, mint close authority — same compliance key as PYUSD/USDGP)
   must be in the stage-4 threat model. Older "WPAXG" SPL tokens
   (`C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe`) are unofficial wrapped copies and
   must not be mistaken for the native mint.
3. **Stage-3 is devnet-only by design** (see `../STAGES.md`): the plan already calls for
   an *unmistakably labeled mock asset* (`MOCK-GOLD`, never "PAXG"). This research
   confirms that plan is the only honest option — labeling any devnet token "PAXG"
   would imply Paxos issuance that does not exist.
4. **PAXGy is out of scope and off-limits for the vault.** It is not on Solana, it is
   not issued by Paxos Trust Company, and its lending-strategy risk profile (credit
   risk, possible downward exchange-rate adjustment) is incompatible with a vault that
   must prove a `deposits >= claims` invariant against a fixed 1:1 gold claim. This is
   consistent with STAGES.md's standing non-claim ("PAXGy is a disabled research
   module") and the "no automatic yield" non-claim.

**Future path (mainnet, stage-4 territory only):** real PAXG collateral on Solana
mainnet becomes *possible in principle* now that a native PAXG deployment is widely
reported — but only after (a) Paxos publishes the official mint address on paxos.com
or confirms it through an official Paxos channel, and (b) the vault's threat model
accounts for Paxos's disclosed freeze/upgrade authority over the token and the 430-PAXG
physical-redemption minimum (no small-holder direct bar redemption). Until both hold,
stage-4's "real PAXG assessment" must record the mint as unverified.

---

## Source list (all accessed 2026-09-27)

| # | Source | Type |
|---|--------|------|
| 1 | https://paxos.com/PAXGold | Official — Paxos product page |
| 2 | https://www.paxos.com/terms-and-conditions/pax-gold-terms-conditions | Official — PAX Gold Terms & Conditions (last modified 2025-12-12) |
| 3 | https://www.prnewswire.com/news-releases/paxos-labs-launches-paxgy-a-paxg-backed-token-that-grows-in-gold-terms-302888407.html | Official — Paxos Labs announcement (2026-09-24) |
| 4 | https://www.cryptotimes.io/2026/06/25/gold-goes-onchain-paxos-launches-paxg-on-solana/ | Third-party news |
| 5 | https://solanacompass.com/news/paxos-brings-pax-gold-to-solana-via-sunrise-making-paxg-the-first-occ-regulated-gold-token-on-the-network | Third-party news |
| 6 | https://www.tronweekly.com/paxos-expands-paxg-to-solana-as-demand/ | Third-party news |
| 7 | https://www.helius.dev/blog/solana-real-world-assets | Third-party (Solana infra dev) |
| 8 | https://github.com/stabbleorg/anchor-common/commit/335539831d1f47a225871568db01067dd5fb7742 | Third-party code — claimed mint, UNVERIFIED |
| 9 | https://www.coindesk.com/price/pax-gold/platforms | Third-party aggregator — WPAXG SPL entry, UNVERIFIED as Paxos-issued |
| 10 | https://www.securities.io/investing-in-pax-gold/ | Third-party — Sept 2026 fee-schedule change, unconfirmed |
| 11 | https://www.newsbtc.com/altcoins/paxos-labs-launches-gold-token-that-can-earn-a-return-in-gold/ | Third-party news |
| 12 | https://cryptobriefing.com/paxos-labs-launches-paxgy-gold-yield-token/ | Third-party news |
| 13 | https://www.solflare.com/prices/pax-gold/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW/ | Wallet — "official Solana contract address", verified-registry claim |
| 14 | https://jup.ag/tokens/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW | DEX aggregator — PAXG token page |
| 15 | https://solscan.io/token/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW | Explorer — native PAXG mint page |
| 16 | https://solscan.io/token/C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe | Explorer — "Paxos Gold (Wormhole)" WPAXG page |
| 17 | https://www.linkedin.com/posts/paxos_paxg-is-now-live-on-solana-via-sunrise-defi-activity-7475915292259426304-A-W8 | Paxos official — LinkedIn launch announcement |
