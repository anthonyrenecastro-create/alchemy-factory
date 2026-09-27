# Architecture

## Programs (`programs/`)

Anchor 0.31 workspace. All mints use **Token-2022**; extensions are chosen per
mechanic and declared before mint creation.

| Program | Responsibility |
|---|---|
| `alchemy_factory` | Experiment registry: mechanic type, config hash, authority set, holder-rights summary hash. Emits disclosure events. |
| `alchemy_curve` | Bonding-curve native (Stage 1). Linear + step templates only. Holds reserve vault, mints/burns against quotes, enforces fees and slippage limits. |
| `alchemy_decay` | Time-decaying: expiry timestamp + periodic decay schedule; defines recipient of removed value and post-expiry transfer/redemption rules. |
| `alchemy_dynamic` | Dynamic/evolving: authenticated data ingestion via oracle adapter; update authority, max supply, update frequency, stale-data behavior, full change history. |
| `alchemy_vessel` | Hierarchical/nested: transferable container PDA over a defined asset set; deposit/withdraw permissions; custody program recorded on-chain. |
| `alchemy_proofx` | Proof of X: attestation-defined minting; verifier, evidence format, nonce-based replay prevention, revocation registry, dispute process. |
| `alchemy_vault` | PAXG collateral module (Stage 3): segregated vault, share accounting, solvency invariant, withdrawal limits, read-only proof accounts. |

### Token-2022 extension policy

- Extensions are selected from a per-mechanic allowlist and shown to the creator
  **before** mint creation, with compatibility warnings (wallet/DEX support).
- **Transfer hooks**: require a hook program; they create integration friction.
  The studio warns explicitly and never enables one silently.
- **Permanent delegate**: grants sweeping transfer/burn power. The studio requires
  a separate, explicit confirmation and displays it on every holder detail page.
- Every privileged authority (mint, freeze, delegate, update, hook) is rendered
  live in the holder app's "Why this token behaves this way" panel.

## RPC & indexing

- **Transactions and state reads**: Chainstack HTTPS/WSS RPC. API credentials are
  server-side only: the frontend uses the app's read proxy (`app/server/rpc-proxy`),
  and scripts read `CHAINSTACK_HTTPS` / `CHAINSTACK_WSS` from gitignored `.env`.
- **Optional mainnet indexing/monitoring**: Yellowstone gRPC Geyser via Chainstack
  add-on. Not required; standard RPC/WebSocket subscriptions are the devnet path.
- Mint identities and network IDs are verified at import; the app refuses to resolve
  an unverified or hardcoded token address.

## SDK (`sdk/`)

Deterministic TypeScript simulation engine:
`curve`, `decay`, `dynamic`, `vessel`, `proofx` simulators plus the **Jubilee**
simulation (PAXG-collateralized token with a disclosed 1%/month claim rule routing
removed value to a named treasury; exact arithmetic, holder outcomes, failure cases).

Simulations run without a wallet, purchase, subscription, or fee — learning is free.

## App (`app/`)

Vite + React + TypeScript. Two surfaces:

- **Studio** (`/studio`): mechanic picker → simple/advanced config → live simulation →
  cost estimate → compatibility warnings → plain-English holder-rights summary →
  review screen → devnet deploy. Mainnet is a separate, explicitly confirmed action.
- **Holder** (`/holder`): wallet connect, discovery, token detail, balances,
  transfers (when permitted), buy/sell (when supported), vault holdings, proof
  status, transaction history, import by verified mint address. Authorities,
  collateral, redemption terms, expiry, fees, and risks are shown **before** signing.
