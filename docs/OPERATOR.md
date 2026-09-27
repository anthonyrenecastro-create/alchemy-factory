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
# Simulation engine (142 tests, all offline)
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

- Paxos launched PAXG natively on Solana on **June 25, 2026** (announced via
  Paxos's official X account; onboarded through Sunrise DeFi; day-one trading
  on Jupiter/Raydium/Kamino/Mayan). The native Solana mint is Token-2022:
  `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`
  (Solscan: https://solscan.io/token/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW).
  Evidence chain is in the research memo: verified on Solana's token registry
  (per Solflare), Jupiter-listed, and independently identified as Paxos's native
  mint with the same compliance authority key as Paxos's PYUSD/USDGP mints.
  Paxos's own site does not print the address — stage-4 integration stays gated
  on direct Paxos confirmation through an official Paxos channel.
- Do NOT confuse it with `C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe` — that is
  **WPAXG**, a Wormhole-wrapped SPL token from June 2025, not the Paxos-issued
  native mint. Never treat it as official PAXG.
- The real PAXG mint carries a **permanent delegate** (plus confidential
  transfers, mint close authority, 0 bps transfer fee) — an irrevocable seizure
  power. Any future real-PAXG work must disclose this; never present the token
  as permissionless. This is also the concrete real-world example for the
  compat checker's red severity on permanent delegates.
- Stage-3 vault work uses the unmistakably labeled `MOCK-GOLD` mock asset,
  **strictly devnet-only**. Never label a devnet token "PAXG"; MOCK-GOLD must
  never appear on mainnet.
- Real PAXG integration is stage-4, mainnet-only, gated on (a) Paxos
  confirmation of the mint, and (b) a threat model covering the
  freeze/upgrade/permanent-delegate authorities and the 430-PAXG
  physical-redemption minimum.

## Vault (stage 3) operator notes

- **MOCK-GOLD devnet setup.** Create the collateral mint as a Token-2022
  mint with **metadata-only extensions** (`metadata-pointer` +
  `token-metadata`) — no permanent delegate, no transfer fees, no frozen
  defaults, no confidential-transfer configs. Name/symbol the mint
  unmistakably, e.g. `MOCK-GOLD — NOT PAXG, NO VALUE`. Faucet-mint units for
  deposit/redeem exercises. Keep the mint address in your local operator
  notes — never in the repo, and **never on mainnet**: MOCK-GOLD must never
  appear on mainnet, and no devnet token may ever be labeled "PAXG".
- **Collateral mint policy.** The stage-3 `alchemy_vault` program allow-lists
  metadata-only collateral mints. The real PAXG mint's extension shape
  (permanent delegate + confidential transfers + mint close authority) is
  **rejected** in stage 3 — do not attempt to register it, and do not confuse
  any devnet mint with the Paxos-issued asset.
- **Proof accounts.** `publish_proof` writes a read-only `VaultProof`
  snapshot: `vault` (the config account), `total_collateral` (vault token
  account balance at publish time), `outstanding_claims` (shares converted at
  the current ratio), `collateral_ratio_bps`
  (`total_collateral * 10000 / outstanding_claims`, `u64::MAX` when no claims
  exist — a "no claims" sentinel, not infinite collateral),
  `authority`, `treasury`, `is_mock_collateral`, `published_ts`. Anyone can
  recompute the ratio from the vault token account balance and the share
  mint's supply — a proof is a signed snapshot, never a promise of future
  value, yield, or a price floor.
- **Withdrawal limits.** Per-redemption cap in bps:
  `gross <= floor(total_collateral * withdrawal_limit_bps / 10000)` or the
  redeem is rejected (`WithdrawalLimitExceeded`). The cap floors, so it never
  rounds past the configured bps. `10000` bps = effectively no limit; lower
  values stage exits and preserve solvency for remaining holders.
- **Program keypair backup.** `programs/target/deploy/alchemy_vault-keypair.json`
  is gitignored and must be backed up off-machine before any deploy —
  losing it means losing the ability to upgrade the program.
- **No devnet deploy without Zebulon's explicit approval.** The vault program
  is UNVERIFIED until both gates pass: (1) CI `anchor build` + `anchor test`
  green on the exact commit, (2) the program deployed to devnet with a real
  end-to-end devnet transaction succeeding. Until then, use the SDK/holder
  simulators only.

## Stage 4 security review — operator-facing behavior changes (2026-09-27)

Internal adversarial review (14 findings, all fixed; details in
[MAINNET_READINESS.md](MAINNET_READINESS.md) §2 — our own review, not an
external audit). Behavior changes operators must know:

- **Vault:** new authority-only `update_vault_treasury` instruction (zero
  address rejected). Curve: authority rotation now rejects the zero address;
  sells whose proceeds round to zero are rejected (`ZeroAmount`) instead of
  burning tokens for nothing.
- **Vessel:** deposits now reject asset mints with hostile Token-2022
  extensions (permanent delegate, freeze authority, transfer hooks/fees —
  `InvalidAssetMint`); only metadata-pointer / token-metadata /
  mint-close-authority are accepted. New `adopt_stray_assets` instruction
  (deposit or withdraw authority) recovers tokens sent directly to custody
  PDAs into the ledger. New owner-gated `update_deposit_authority` /
  `update_withdraw_authority` (zero address rejected).
- **ProofX:** `initialize_proofx` now requires the mint's current mint
  authority as a signer (anti-squatting). Flow: create the mint with yourself
  as mint authority → initialize → set the mint authority to the config PDA.
- **Decay:** `close_decay` now requires the schedule to be fully settled
  (run a final crank first) — `ScheduleNotSettled` otherwise.
- **Dynamic:** `initialize_dynamic` now verifies the mint is actually owned by
  the Token-2022 program (`NotToken2022` otherwise).
- **All programs:** authority rotation rejects the all-zero pubkey
  (`InvalidAuthority`/`InvalidPubkey`) — a rotation typo to address zero can no
  longer brick admin. (A typo to a *valid-but-wrong* address still locks out
  admin; two-step propose/accept is deferred to pre-mainnet hardening.)

## Secrets

- `.env`, `.keys/`, keystores: gitignored, stay on the operator's machine.
- Back up signing keys off-machine before any Play/upload or mainnet step.
