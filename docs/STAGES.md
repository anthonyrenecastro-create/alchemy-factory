# Stage plan & honesty matrix

Delivery happens in four stages. For each stage this file states:
**on-chain** (real Solana program behavior), **off-chain** (servers/indexers),
**simulated** (frontend/SDK models, no chain state), **tested** (what evidence exists),
and **incomplete** (what is not done). Claims never exceed evidence.

## Verification standard (applies to every program in this repo)

A Solana program is **UNVERIFIED** until **both** of these hold:

1. **CI gate:** `anchor build` + `anchor test` pass on the exact commit (GitHub Actions).
2. **Devnet end-to-end:** the program is deployed to devnet and a real transaction
   exercising its instructions succeeds on devnet (not just a local validator).

Until both gates pass, every UI surface, doc, and status line must describe the
program as unverified / not yet confirmed on-chain. Passing CI alone is necessary
but not sufficient. Skipping either gate and calling a program "done" or
"production-ready" is not permitted in this project.

## Stage 1 — Functional devnet studio + holder app, one fully tested mechanic

| Area | Status |
|---|---|
| On-chain | `alchemy_factory` registry + `alchemy_curve` (linear & step bonding-curve templates) implemented. **UNVERIFIED**: not yet deployed to devnet and no end-to-end devnet transaction has succeeded — see the Verification standard above. Deployment needs explicit approval. |
| Off-chain | Chainstack HTTPS/WSS RPC reads via server-side proxy; no indexer yet |
| Simulated | Studio simulations for all five mechanics; cost estimates; holder views for unlisted mechanics |
| Tested | Anchor tests: buy/sell math, fee accounting, slippage bounds, authority abuse (mint/freeze attempts by non-authority), rounding at curve steps, curve-manipulation (sandwich within one slot) |
| Incomplete | Remaining four mechanics have no programs yet; no PAXG vault; mainnet not touched |

## Stage 2 — All five mechanic families with simulations and compatibility checks

| Area | Status |
|---|---|
| On-chain | `alchemy_decay`, `alchemy_dynamic`, `alchemy_vessel`, `alchemy_proofx` **implemented** (Anchor 0.31.1, Token-2022 only, no transfer hooks / permanent delegates). **UNVERIFIED**: CI compilation/testing is running but not yet confirmed green, and no devnet deployment or end-to-end devnet transaction has happened — see the Verification standard above. **Not deployed to devnet** — deployment needs explicit approval. |
| Off-chain | Compatibility checker (`sdk/src/compat.ts`): Token-2022 extension combination validated **before** mint creation against the research severity matrix (green/amber/red); red findings block the studio deploy step until explicitly acknowledged. Wallet/DEX notes carry vintage labels. |
| Simulated | Full simulation coverage incl. stale-oracle, expiry, decay, attestation-replay scenarios; SDK math mirrors on-chain math exactly (decay period counting, dynamic update validation) |
| Tested | Anchor tests add: stale oracle data rejection (incl. boundary semantics), proof replay rejection (nonce PDA), transfer-restriction declarations, vessel ownership-change safety + holding invariant, decay schedule correctness (expiry capping, tick math, recipient disclosure), authority abuse, rounding edges |
| Incomplete | PAXG vault still mock-only; no mainnet deployment; programs not yet independently audited |

Honest scope notes for Stage 2 (what the programs do and do NOT do):
- `alchemy_decay` is the deterministic **schedule authority**: `apply_decay` advances decay periods with exact integer math and discloses the removed-value recipient. It moves no tokens itself — per-holder decayed balances are derived from the on-chain counters (display layer). Post-expiry transfer/redemption flags are on-chain **declarations**, not program-enforced (enforcement would require a transfer hook, which Stage 2 does not silently enable).
- `alchemy_dynamic` enforces freshness / monotonicity / frequency / supply-cap on ingested updates and keeps an append-only history. It does not interpret the economic meaning of `value`, and the off-chain data source is named, never described as decentralized.
- `alchemy_vessel` custodies assets in PDA-owned Token-2022 accounts with a holding invariant asserted on every flow. Direct transfers to a custody account desynchronize the ledger (v1 has no sweep instruction).
- `alchemy_proofx`: the verifier's co-signature on the mint transaction **is** the attestation. A human verifier is "manually approved", never "automatically verified". Revocation flags claims; it does not burn already-minted tokens.

## Stage 3 — PAXG vault prototype (mock collateral on devnet)

| Area | Status |
|---|---|
| On-chain | `alchemy_vault` implemented (Anchor 0.31.1, Token-2022 only): `initialize_vault`, `deposit_collateral`, `redeem_shares`, `publish_proof`, `update_vault_authority`. Segregated PDA vault, share accounting (first deposit 1:1, pro-rata thereafter with dust rejection), bps-capped withdrawal limit, redeem fee with ceil rounding, metadata-only share mint (MetadataPointer + TokenMetadata), collateral extension allow-list (MetadataPointer, TokenMetadata, MintCloseAuthority only), solvency invariant on every flow, read-only proof of balance/liabilities/ratio/authorities. Real native Solana PAXG (`5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`) is **rejected** as Stage 3 collateral: its permanent delegate violates the allow-list, so it can never initialize a vault here (a Stage 4 decision, not a silent downgrade). **UNVERIFIED**: CI green is necessary but not sufficient; no devnet deploy or end-to-end devnet transaction has succeeded yet — deployment needs explicit approval. |
| Off-chain | Price feed adapter for collateral valuation (labeled source, never implied decentralized) |
| Simulated | Devnet uses an **unmistakably labeled mock asset** (`MOCK-GOLD`, never "PAXG"). MOCK-GOLD is strictly devnet-only: it must never appear on mainnet, and no devnet token may be labeled PAXG. New holder Vault simulator page runs the deterministic SDK mirror (deposit/redeem math, withdrawal limits, collateral ratio, proof-account explainer) — simulation only. |
| Tested | SDK vault tests (`sdk/src/test/vault.test.ts`): deposit pro-rata/floor with dust rejection, redeem gross/fee-up/net, withdrawal-limit boundary (`gross == limit` passes, `limit + 1` fails), `u64::MAX` ratio sentinel when no claims exist, bps validation, adversarial multi-step pro-rata fairness. Anchor (`programs/tests/vault.ts`): init (PDAs, metadata-only `AVS-MOCK` share mint, config), invalid bps/labels, transfer-fee collateral-mint rejection, mint mismatch, 1:1 first deposit + pro-rata second deposit, zero/wrong-mint deposits, redeem fee math (exact + ceil), withdrawal-limit boundary, over/zero redeem, treasury/authority abuse, proof fields incl. donation-surplus ratio, full redeem-to-zero. |
| Incomplete | Real PAXG integration. The native Solana PAXG mint is now identified (`5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`, Token-2022, evidence chain in `docs/research/paxg-solana.md`) — but integration stays gated on (a) direct Paxos confirmation of the mint through an official Paxos channel, and (b) a threat model covering the mint's **permanent delegate** + freeze/upgrade authorities and the 430-PAXG physical-redemption minimum. Do not confuse it with `C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe`, which is **WPAXG** (Wormhole-wrapped, June 2025), not the Paxos-issued mint. |

## Stage 4 — Security review, real PAXG assessment, mainnet readiness report

| Area | Status |
|---|---|
| On-chain | **Implemented** (all seven programs). Internal adversarial review complete 2026-09-27: **14 findings, all fixed in program code, each with a regression test** (Anchor tests + SDK tests). Findings: vessel `TransferContainer` struct missing (did not compile) [critical]; vessel hostile-extension acceptance, custody-PDA griefing, proofx config squatting [high]; decay close settlement, dynamic Token-2022 mint check, curve zero-proceeds sells, vault treasury rotation, SDK/oracle validation parity [medium]; zero-address authority bricking, test gaps [low]. Residual risks documented in [MAINNET_READINESS.md](MAINNET_READINESS.md) (single-step rotation typos, locked donations, proofx authority rotation). This was **our own review, not an independent audit**. **UNVERIFIED**: CI green is necessary but not sufficient; no devnet deploy or end-to-end devnet transaction has succeeded — deployment needs explicit approval. |
| Off-chain | Yellowstone gRPC Geyser evaluated as **optional mainnet indexing/monitoring** (standard RPC/WebSocket remain the devnet path) |
| Simulated | Jubilee simulation stays a simulation until vault, redemption, and treasury rules are tested |
| Tested | Full threat-model review; fixes verified in CI (SDK 142/142; Anchor tests run in CI) |
| Incomplete until done | Production readiness, any yield claims, physical-gold redemption path, Paxos confirmation of the native mint (see [MAINNET_READINESS.md](MAINNET_READINESS.md) §1–§4 for the full gate list) |

## Standing non-claims

- No guaranteed gold price floor — the UI shows a **calculated** collateral value / redemption claim.
- No automatic yield, self-repaying loans, or prize pools (PAXGy is a disabled research module).
- No claim of universal wallet/DEX compatibility — transfer hooks and permanent delegates are disclosed, never silently enabled.
- No regulatory approval implied by anything in this repository.
