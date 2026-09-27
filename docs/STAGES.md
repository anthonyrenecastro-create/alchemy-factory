# Stage plan & honesty matrix

Delivery happens in four stages. For each stage this file states:
**on-chain** (real Solana program behavior), **off-chain** (servers/indexers),
**simulated** (frontend/SDK models, no chain state), **tested** (what evidence exists),
and **incomplete** (what is not done). Claims never exceed evidence.

## Stage 1 — Functional devnet studio + holder app, one fully tested mechanic

| Area | Status |
|---|---|
| On-chain | `alchemy_factory` registry + `alchemy_curve` (linear & step bonding-curve templates) deployed to **devnet** |
| Off-chain | Chainstack HTTPS/WSS RPC reads via server-side proxy; no indexer yet |
| Simulated | Studio simulations for all five mechanics; cost estimates; holder views for unlisted mechanics |
| Tested | Anchor tests: buy/sell math, fee accounting, slippage bounds, authority abuse (mint/freeze attempts by non-authority), rounding at curve steps, curve-manipulation (sandwich within one slot) |
| Incomplete | Remaining four mechanics have no programs yet; no PAXG vault; mainnet not touched |

## Stage 2 — All five mechanic families with simulations and compatibility checks

| Area | Status |
|---|---|
| On-chain | `alchemy_decay`, `alchemy_dynamic`, `alchemy_vessel`, `alchemy_proofx` **implemented** (Anchor 0.31.1, Token-2022 only, no transfer hooks / permanent delegates); compiled and tested in CI. **Not yet deployed to devnet** — deployment needs explicit approval. |
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
| On-chain | `alchemy_vault`: segregated vault, share accounting, withdrawal limits, read-only proof of balance/liabilities/ratio/authorities |
| Off-chain | Price feed adapter for collateral valuation (labeled source, never implied decentralized) |
| Simulated | Devnet uses an **unmistakably labeled mock asset** (`MOCK-GOLD`, never "PAXG") |
| Tested | Insolvency guard (`deposits >= claims` invariant), rounding on mint/redeem, withdrawal-limit preservation of solvency |
| Incomplete | Real PAXG integration pending verification of the official Paxos Solana mint address |

## Stage 4 — Security review, real PAXG assessment, mainnet readiness report

| Area | Status |
|---|---|
| On-chain | Only after review; mainnet launch requires explicit user confirmation |
| Off-chain | Yellowstone gRPC Geyser evaluated as **optional mainnet indexing/monitoring** (standard RPC/WebSocket remain the devnet path) |
| Simulated | Jubilee simulation stays a simulation until vault, redemption, and treasury rules are tested |
| Tested | Full threat-model review; fixes verified in CI |
| Incomplete until done | Production readiness, any yield claims, physical-gold redemption path |

## Standing non-claims

- No guaranteed gold price floor — the UI shows a **calculated** collateral value / redemption claim.
- No automatic yield, self-repaying loans, or prize pools (PAXGy is a disabled research module).
- No claim of universal wallet/DEX compatibility — transfer hooks and permanent delegates are disclosed, never silently enabled.
- No regulatory approval implied by anything in this repository.
