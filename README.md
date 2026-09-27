# Alchemy Factory

A Solana-first creator studio and companion holder app for experimental tokens.
Design, simulate, launch, and understand functional token mechanics at low initial cost.

- **Creator studio** — pick one of five mechanic families, configure in simple or
  advanced mode, run a live economic simulation, see estimated creation costs and
  compatibility warnings, read a plain-English summary of holder rights, and review
  before deploying. Devnet first; mainnet requires explicit confirmation.
- **Holder app** — connect a wallet, discover tokens, inspect live authorities,
  collateral, redemption terms, expiry, fees, and risks before signing anything.
- **PAXG collateral module** — optional, segregated on-chain vault. Mock asset on
  devnet (unmistakably labeled); real PAXG only after the official Paxos Solana mint
  address is verified from current Paxos documentation.

## The five mechanic families

1. **Dynamic & evolving** — metadata/supply changes from authenticated data
   (oracle adapter; off-chain sources are never described as decentralized).
2. **Time-decaying** — fixed expiration plus a separately specified periodic decay model.
3. **Hierarchical & nested** — a transferable container over a defined set of assets.
4. **Bonding-curve native** — a small audited set of curve templates (linear, step).
   No arbitrary user-supplied executable formulas in v1.
5. **Proof of X** — mint from a verifiable attestation with replay prevention and
   revocation. Manual approval is never described as automatic verification.

## Repository layout

| Path | Contents |
|---|---|
| `programs/` | Anchor workspace: 7 Solana programs + Anchor tests + CI |
| `sdk/` | TypeScript client + deterministic simulation engine for all five mechanics and the Jubilee simulation |
| `app/` | Vite + React frontend: creator studio and holder app |
| `scripts/` | Reproducible devnet setup, key generation, deploy scripts |
| `docs/` | Architecture, operator docs, stage honesty matrix, research notes |

## What is real vs. simulated

See [`docs/STAGES.md`](docs/STAGES.md) — every stage states what runs on-chain,
what runs off-chain, what is simulated, what has been tested, and what is incomplete.
We do not claim production readiness, a guaranteed gold floor, regulatory approval,
automatic yield, or universal wallet/DEX compatibility without evidence.

## Quick start (devnet)

```bash
# 1. Environment: keypairs + devnet funding + Chainstack endpoint config
./scripts/devnet-setup.sh

# 2. Programs (compiled + tested in CI; see docs/OPERATOR.md)
cd programs && anchor build && anchor test

# 3. Simulation engine tests
cd sdk && npm install && npm test

# 4. Frontend (simulation-first; no wallet required to learn)
cd app && npm install && npm run dev
```

Chainstack HTTPS/WSS RPC is used for transactions and state reads. Credentials stay
server-side (`scripts/devnet-setup.sh` writes them to a gitignored `.env`, and the
frontend talks to RPC through the app's own read proxy, never with a key in the bundle).

## License

MIT — see [LICENSE](LICENSE).
