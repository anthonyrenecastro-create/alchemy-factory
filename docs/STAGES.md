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
| On-chain | `alchemy_decay`, `alchemy_dynamic`, `alchemy_vessel`, `alchemy_proofx` on devnet |
| Off-chain | Compatibility checker: Token-2022 extension combination declared **before** mint creation; wallet/DEX integration notes |
| Simulated | Full simulation coverage incl. stale-oracle, expiry, decay, attestation-replay scenarios |
| Tested | Anchor tests add: stale oracle data rejection, proof replay rejection, transfer-restriction enforcement, vault ownership-change safety |
| Incomplete | PAXG vault still mock-only; no mainnet deployment |

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
