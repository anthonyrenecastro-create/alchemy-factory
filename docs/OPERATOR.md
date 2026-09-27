# Operator documentation

How to build, test, configure, and deploy Alchemy Factory. Read
[STAGES.md](STAGES.md) first for the honesty matrix: what is on-chain, what is
simulated, and what is incomplete at each stage.

## Prerequisites

| Component | Needs |
|---|---|
| SDK / app | Node 22+, npm |
| Solana programs | Rust stable, Solana CLI, Anchor 0.31.1 (via `avm`) — **or** use CI |
| Devnet deploy | Solana CLI configured for devnet, a funded keypair, Chainstack endpoint |

> This project's development VM has no Rust toolchain, so programs are
> compiled and tested in GitHub Actions (`.github/workflows/ci.yml`).
> Expect possible minor Anchor codegen friction on the first CI run; the
> workflow is the gate, not local builds.

## Reproducible devnet setup

```bash
./scripts/devnet-setup.sh
```

This generates `.keys/deployer.json`, funds it from the devnet faucet, and
writes a gitignored `.env` with:

- `SOLANA_CLUSTER=devnet`
- `DEPLOYER_KEYPAIR` — path to the deployer keypair
- `CHAINSTACK_HTTPS` / `CHAINSTACK_WSS` — fill in your Chainstack endpoint.
  The API key is a URL path segment:
  `https://solana-devnet.core.chainstack.com/YOUR_KEY`.
  **Never put this key in the frontend bundle or commit `.env`.**

The frontend reads its RPC URL from `VITE_RPC_URL` (defaults to the public
devnet endpoint). For Chainstack-backed reads, run the app behind the
server-side read proxy described in [ARCHITECTURE.md](ARCHITECTURE.md) —
the browser must never hold the API key.

## Build & test

```bash
# Simulation engine (41 tests, all offline)
cd sdk && npm install && npm test

# Frontend
cd app && npm install && npm run dev     # simulation-first; no wallet needed

# Solana programs (CI is the gate; see note above)
cd programs && anchor build && anchor test
```

## Math parity (important)

`sdk/src/curve.ts` mirrors `programs/alchemy_curve/src/math.rs` **exactly**:
same linear parametrization (`price = basePrice + slope*supply/PRICE_SCALE`,
`PRICE_SCALE = 1_000_000_000`), same integer arithmetic, same rounding
(buys ceil against the trader, sells floor for the reserve, fees ceil both
ways), same slippage/impact rails. The UI builds linear configs with
`linearFromPerToken()` so the displayed "slope per token" matches on-chain
behavior. If you change the program's math, update the SDK in the same commit
and re-run `npm test` in `sdk/`.

## Deploying programs to devnet

1. Program keypairs: `node scripts/gen-program-keypairs.js` (run from the repo
   root; needs `cd programs && npm install` first for `@solana/web3.js`).
   This writes `programs/target/deploy/<program>-keypair.json` — **gitignored,
   never committed**. The same command reuses existing keypairs on re-run, so
   program IDs stay stable. **Back up these keypair files off-machine before
   any deploy**; losing one means losing the ability to upgrade that program.
2. `anchor build` and note the program IDs in `programs/target/deploy/`.
3. Replace the placeholder IDs in `programs/Anchor.toml` **and** every
   `declare_id!` with the real ones (they must match exactly). Stage 2 did
   this for all seven programs; verify with
   `grep -h declare_id! programs/programs/*/src/lib.rs`.
4. `anchor deploy --provider.cluster devnet`
5. Register each experiment via the `alchemy_factory` program so authorities
   and holder-rights summaries are on-chain and discoverable.

**Mainnet is never a default.** The studio's mainnet path requires typing an
explicit confirmation, and any real mainnet deployment needs Zebulon's direct
go-ahead — no exceptions.

## Chainstack notes (from `docs/research/chainstack-solana.md`)

- Billing is in Request Units; the free Developer tier includes devnet nodes
  (higher limits than mainnet).
- `getProgramAccounts`, `getSupply`, and `getTokenAccountsByOwner` are
  **paid-plan-only** — the holder app's discovery must not depend on them on
  the free tier.
- Yellowstone gRPC Geyser is a paid add-on, **mainnet only** — it is the
  optional stage-4 indexing path, not the devnet path.

## PAXG policy (from `docs/research/paxg-solana.md`)

- Paxos publishes **no official Solana mint address** for PAXG. A third-party
  Solana mint exists but is **unverified** — never hardcode it, never treat it
  as official.
- Stage-3 vault work uses the unmistakably labeled `MOCK-GOLD` mock asset.
- Real PAXG integration is stage-4, gated on Paxos publishing or confirming an
  official Solana mint address.

## Secrets

- `.env`, `.keys/`, keystores: gitignored, stay on the operator's machine.
- Back up signing keys off-machine before any Play/upload or mainnet step.
