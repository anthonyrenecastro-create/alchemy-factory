# Mainnet Readiness — Alchemy Factory

**Date:** 2026-09-27
**Status: NOT READY.** This document records what a mainnet launch would
require. Nothing in this repository is production-ready, nothing here is
deployed, and all seven programs are **UNVERIFIED** (see the Verification
standard in [STAGES.md](STAGES.md): CI green **plus** a successful end-to-end
devnet transaction — deployment itself needs Zebulon's explicit approval).

This document is the stage-4 deliverable. It is an internal assessment written
by the project's own builders — **not an independent audit, not a security
certification, and not a claim of production readiness.**

---

## 1. Evidence-backed PAXG assessment

### 1.1 The native Solana mint

Paxos launched PAXG natively on Solana on **June 25, 2026**, announced via
Paxos's official X account and onboarded through **Sunrise DeFi** (Wormhole's
asset-onboarding pipeline), with day-one trading on Jupiter, Raydium, Kamino,
and Mayan. The deployment uses the **Token-2022** standard.

**Native mint:** `5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`
([Solscan](https://solscan.io/token/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW))

Evidence chain (convergent, third-party — Paxos's own site does not print the
address; see the honesty caveat in §1.4):

- Solflare wallet: *"The official Solana contract address for PAX Gold is
  5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW"*, *"verified on Solana's token
  registry"*.
- Jupiter token page: `jup.ag/tokens/5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`.
- Stabble (Solana DeFi developer, commit 2026-07-13): on-chain analysis
  identifying it as *"Paxos's native Solana PAXG mint"* with the same
  compliance authority key as Paxos's PYUSD/USDGP mints.

Full trail with access dates: [research/paxg-solana.md](research/paxg-solana.md)
(2026-09-27 CORRECTION section).

### 1.2 WPAXG is not PAXG

`C6oFsE8nXRDThzrMEQ5SxaNFGKoyyfWDDVPw37JKvPTe` is **WPAXG** — a Wormhole-wrapped
SPL token dated 2025-06-21, a year *before* the native launch. Solscan titles it
"Paxos Gold (Wormhole)". It is not issued by Paxos and must never be treated as
the native mint, accepted as vault collateral, or displayed as PAXG anywhere.

### 1.3 The extension profile — and what it means for a vault

Per the Stabble on-chain analysis, the native mint carries:

- **Permanent delegate** — an irrevocable seizure power over any holder's
  balance, held by the same compliance key as Paxos's PYUSD/USDGP.
- **Mint close authority.**
- **Confidential transfers** enabled.
- Inactive transfer hook (null program id), 0 bps transfer fee.

**Consequences:**

1. Real PAXG is **not a permissionless asset**. Any product surface touching it
   must disclose the permanent delegate and freeze/upgrade powers; the
   "compat checker" red severity for permanent delegates exists precisely for
   this shape.
2. The stage-3 `alchemy_vault` collateral allow-list
   (`metadata-pointer` + `token-metadata` + `mint-close-authority` only)
   **rejects the real PAXG mint today**. Accepting it is a deliberate stage-4+
   product decision — an explicit allow-list entry for this exact mint plus
   holder-facing disclosure — never a silent downgrade of the allow-list.
3. Confidential transfers complicate proof-of-reserves: encrypted balances are
   not publicly auditable. A real-PAXG vault needs a defined proof procedure
   before mainnet, not after.

### 1.4 Honesty caveat

Paxos has not published the Solana mint address on paxos.com. The address above
rests on convergent third-party evidence, not on a Paxos-published source.
**Stage-4 integration stays gated on direct Paxos confirmation through an
official Paxos channel.** Until then, the mint is "reported", not "confirmed".

### 1.5 Redemption reality (from Paxos's official terms)

- Only verified Paxos customers may redeem; Paxos may refuse on compliance
  grounds.
- **430-PAXG minimum** for allocated physical (London Good Delivery bar)
  redemption, plus fees; the customer arranges and pays for delivery.
- Paxos retains aggregate freeze/upgrade authority over the token (ERC20 terms
  §14.1; the Solana deployment's permanent delegate is the Token-2022
  analogue).
- There is **no small-holder direct bar redemption path**. Any UI suggesting
  otherwise would be false.

---

## 2. Stage-4 internal security review — findings and fixes

On 2026-09-27 the project ran an adversarial review of all seven programs
across nine attack classes (authority abuse, insolvency, rounding, stale data,
replay, curve manipulation, restriction bypass, ownership change, account
substitution/PDA confusion). **14 findings, all fixed in program code, each
with a regression test** (Anchor tests in `programs/tests/` and/or SDK tests
in `sdk/src/test/`). Again: this is our own review, not an external audit.

### alchemy_factory / alchemy_decay / alchemy_dynamic (4 findings)

1. **[Medium] Dynamic accepted non-Token-2022 mints at init.** `initialize_dynamic`
   checked the `token_program` account but never that the mint was owned by
   Token-2022; Anchor's `InterfaceAccount<Mint>` also deserializes legacy SPL
   mints. Fixed: `require_keys_eq!(*mint.owner, token_2022::ID, NotToken2022)`.
2. **[Medium] Decay close could strand unsettled periods.** `close_decay` only
   required `now >= expiry_ts`; closing without a final crank permanently
   undercounted the schedule. Fixed: close now requires the schedule be fully
   settled (`ScheduleNotSettled` otherwise).
3. **[Low] Authority rotation to the zero pubkey bricked admin** in all three
   programs (for dynamic, pause could never be lifted). Fixed: `InvalidAuthority`
   guard on every rotation path.
4. **[Low] Test gap:** the `RecipientMismatch` guard on decay close had no
   coverage. Fixed: regression test added.

### alchemy_vault / alchemy_curve (5 findings)

5. **[Medium] Curve authority rotation accepted the zero address** (the vault
   already rejected it). Fixed: `InvalidPubkey` guard; error appended at the
   end of the enum so existing discriminants are unchanged.
6. **[Medium] Curve sells could burn tokens for zero proceeds.** A floored
   integral rounding to 0 (e.g. linear curve, intercept 0, tiny slope) burned
   the trader's tokens and paid nothing. Fixed: `ZeroAmount` guard after
   `sell_proceeds`.
7. **[Medium] Vault treasury had no rotation path** — a lost treasury key
   stranded all future fees. Fixed: new authority-only `update_vault_treasury`
   instruction (zero address rejected, event emitted).
8. **[Medium] SDK `validateCurveConfig` was looser than on-chain `validate_curve`**
   for step curves (no non-decreasing check, no 32-step cap). Fixed: SDK now
   mirrors the on-chain validation exactly.
9. **[Low] Collateral allow-list had no machine-checkable SDK mirror.**
   Fixed: `checkVaultCollateral()` + `VAULT_COLLATERAL_ALLOWED_EXTENSIONS`
   in `sdk/src/compat.ts`, mirroring `validate_collateral_mint` exactly.

### alchemy_vessel / alchemy_proofx (5 findings)

10. **[CRITICAL] Vessel `TransferContainer` accounts struct was missing** —
    the program did not compile at all. Fixed: struct added matching the
    intended account list.
11. **[HIGH] Vessel accepted hostile Token-2022 extensions.** No extension
    validation on `deposit_asset`: a permanent delegate could drain the custody
    PDA, a freeze authority could brick withdrawals. Fixed: `validate_asset_mint()`
    allow-lists only `MetadataPointer`/`TokenMetadata`/`MintCloseAuthority`
    (`InvalidAssetMint` otherwise).
12. **[HIGH] Permissionless griefing via direct transfers to custody PDAs.**
    Anyone could send tokens straight to a custody PDA, desyncing the ledger
    and bricking all later deposits/withdrawals with `HoldingMismatch`.
    Fixed: new `adopt_stray_assets` instruction (deposit or withdraw authority
    only) that credits stray balances into the ledger — it only ever writes the
    ledger *up*.
13. **[MEDIUM] Vessel authorities were immutable** — lost key, locked funds.
    Fixed: owner-gated `update_deposit_authority` / `update_withdraw_authority`
    (default pubkey rejected).
14. **[HIGH] ProofX config squatting.** `initialize_proofx` was permissionless:
    anyone could pre-register the `["proofx", mint]` PDA for someone else's mint
    and permanently block the legitimate deployment. Fixed: the mint's current
    mint authority must sign initialization (`InvalidMintAuthority` otherwise).
    Intended flow: create mint with yourself as authority → init → set mint
    authority to the config PDA.

### Reviewed and found sound (no change)

- Factory registry anti-squatting (PDA seeds bind the creator's key;
  re-registration blocked).
- Dynamic oracle write-time matrix (future/stale/monotonicity/frequency/cap);
  staleness is write-time-only by design (no on-chain consumer exists yet).
- Vault solvency invariant and curve reserve-delta invariant on every path.
- ProofX replay prevention (nonce PDAs survive rotation and revocation).
- PDA seeds distinct per program; no cross-program collisions.
- Rounding directions (deposit/redeem/sell floor for the reserve, fees ceil);
  dust rejection; withdrawal-limit flooring.

### Residual risks (accepted, documented)

- Authority rotation is single-step: a typo to a *valid-but-wrong* address still
  locks out admin. Two-step propose/accept was judged disproportionate for this
  pass; it belongs in a pre-mainnet hardening round.
- Direct donations to vault/custody PDAs are permanently locked (now recoverable
  into the vessel ledger via `adopt_stray_assets`; curve/vault donations remain
  locked and are surfaced honestly in proofs).
- ProofX `authority`/`revocation_authority` have no rotation (liveness-only, no
  fund risk).

---

## 3. Mainnet gates (all must hold)

1. **Direct Paxos confirmation** of the native mint address through an official
   Paxos channel (§1.4).
2. **Threat model for privileged authorities**: permanent delegate seizure,
   freeze/upgrade, mint close — with an explicit allow-list decision and
   holder-facing disclosure for real PAXG. Never permissionless framing.
3. **Confidential-transfer proof procedure** for proof-of-reserves, defined and
   tested.
4. **430-PAXG redemption minimum** disclosed wherever redemption is mentioned.
5. **Both verification gates green**: CI `anchor build` + `anchor test` on the
   exact commit, **and** a successful end-to-end devnet transaction.
6. **Zebulon's explicit approval** for any deployment — devnet first, mainnet
   only after devnet is proven.

## 4. What remains unverified and why

- **All seven programs are UNVERIFIED.** They have never been deployed anywhere
  and no end-to-end devnet transaction has succeeded. CI alone is necessary but
  not sufficient (Verification standard, [STAGES.md](STAGES.md)).
- The stage-4 review above is **internal** — it is not an independent audit and
  must never be described as one.
- The PAXG mint address is **reported, not Paxos-confirmed** (§1.4).
- The Jubilee simulation stays a simulation until vault, redemption, and
  treasury rules are tested against real on-chain behavior.
- No guaranteed gold floor, no yield, no regulatory approval — the standing
  non-claims in [STAGES.md](STAGES.md) apply unchanged.
