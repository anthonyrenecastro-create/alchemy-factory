/**
 * Attestation model for the `proofx` (Proof of X) mechanic.
 *
 * SIMULATION ONLY: pure functions, no chain state.
 *
 * On-chain authorization model (mirrored here): an attestation is valid iff
 * the configured verifier key SIGNED the mint transaction. The verifier
 * signs over the instruction data (attestation hash, nonce, amount) and the
 * accounts (claimant, config, mint), so the signature binds all of them —
 * it cannot be transplanted onto a different claimant, amount, or nonce.
 * There is no separate off-chain signature object for the program to check:
 * the transaction signature IS the attestation authorization, and the
 * program does not inspect evidence (whatever review happened off-chain is
 * outside its view).
 *
 * In this simulation there is no transaction, so `verifyApproval` stands in
 * for "the verifier reviewed the evidence off-chain and approved this claim".
 * The studio always labels this as simulated — it is not a real signature.
 *
 * Honesty rule: a manually approved claim is NEVER described as automatic
 * verification. `automatic: false` means a human (or off-chain process) signs
 * off; the UI must say so. Only `automatic: true` with a real verifier
 * program may be described as automatic — and in this simulation the approval
 * check is an injected stub, so the studio always labels it as simulated.
 *
 * Replay prevention: one claim record per nonce, mirroring the on-chain
 * ClaimRecord PDA (`["claim", config, nonce]`). A second mint with the same
 * nonce is rejected (on-chain it fails at account initialization).
 *
 * Revocation: a boolean flag on the claim record. Setting it is a REGISTRY
 * FLAG ONLY — it does not burn or claw back already-minted tokens, exactly
 * like on-chain `revoke_claim`. There is no pre-mint revocation registry
 * on-chain: revoking an attestation that was never minted is an error
 * (on-chain the claim account would not exist).
 *
 * Simulation-only policy (NOT enforced on-chain): `issuedAt`/`expiresAt`
 * attestation time bounds. The program records `dispute_window_seconds` as a
 * disclosed policy field but does not enforce expiry; the studio models
 * expiry so creators can explore the policy, labeled as simulation-only.
 */

export interface Attestation {
  attestationId: string;
  /** Base58 pubkey of the holder the attestation is about. */
  subject: string;
  /** What is being proven, e.g. 'completed-course:alchemy-101'. */
  claimType: string;
  /** Hash of the evidence; the evidence FORMAT is defined in the config. */
  evidenceHash: string;
  /** Unique per attestation — reuse is rejected (replay prevention). */
  nonce: string;
  /** Simulation-only: the studio models time bounds; on-chain does not enforce them. */
  issuedAt: number;
  /** Simulation-only: the studio models time bounds; on-chain does not enforce them. */
  expiresAt: number;
  /** Base58 pubkey of the verifier that approved this attestation. */
  verifier: string;
}

export interface ProofXConfig {
  /** Base58 pubkeys trusted to issue attestations (on-chain: exactly one verifier key, rotatable). */
  trustedVerifiers: string[];
  /** Evidence format, e.g. 'sha256-of-signed-completion-certificate'. */
  evidenceFormat: string;
  replayPrevention: 'nonce-set';
  /** Base58 pubkey that may revoke attestations, or null (irrevocable). */
  revocationAuthority: string | null;
  /** Plain-English dispute process shown to holders. */
  disputeProcess: string;
  /** Plain-English privacy treatment shown to holders. */
  privacyTreatment: string;
  /**
   * false = a human/off-chain process approves claims (manual).
   * NEVER describe manual approval as automatic verification.
   */
  automatic: boolean;
}

export interface MintRecord {
  attestationId: string;
  subject: string;
  amount: bigint;
  mintedAt: number;
  /** The consumed nonce — mirrors the on-chain ClaimRecord PDA seed. */
  nonce: string;
  /**
   * Revocation is a REGISTRY FLAG only. `true` means the revocation
   * authority flagged this claim; the minted tokens are NOT burned or
   * clawed back — exactly like on-chain `revoke_claim`.
   */
  revoked: boolean;
}

export interface ProofXState {
  config: ProofXConfig;
  /** Consumed nonces — append-only; mirrors the on-chain ClaimRecord PDA set. */
  usedNonces: string[];
  /** One record per consumed nonce (each carries its revocation flag). */
  minted: MintRecord[];
}

/**
 * Injected approval check. In the on-chain model the verifier's signature on
 * the mint transaction IS the authorization; here this stub stands in for
 * "the verifier reviewed the evidence off-chain and approved this claim".
 * Always labeled as simulated by the studio.
 */
export type VerifyApprovalFn = (att: Attestation) => boolean;

export function createProofXState(config: ProofXConfig): ProofXState {
  if (config.trustedVerifiers.length === 0) throw new Error('NO_TRUSTED_VERIFIERS');
  return { config, usedNonces: [], minted: [] };
}

/**
 * Verify an attestation against the state. Returns silently on success; throws on:
 *  - UNTRUSTED_VERIFIER, REPLAYED_NONCE,
 *  - EXPIRED_ATTESTATION, NOT_YET_VALID (simulation-only time policy),
 *  - APPROVAL_DENIED (the injected approval check failed).
 *
 * Note: revocation does NOT block verification here. On-chain there is no
 * pre-mint revocation registry — `revoke_claim` flags an existing claim
 * record, and a revoked claim's nonce is already consumed, so re-minting
 * fails with REPLAYED_NONCE anyway.
 */
export function verifyAttestation(
  state: ProofXState,
  att: Attestation,
  verifyApproval: VerifyApprovalFn,
  now: number,
): void {
  if (!state.config.trustedVerifiers.includes(att.verifier)) throw new Error('UNTRUSTED_VERIFIER');
  if (state.usedNonces.includes(att.nonce)) throw new Error('REPLAYED_NONCE');
  if (now > att.expiresAt) throw new Error('EXPIRED_ATTESTATION');
  if (now < att.issuedAt) throw new Error('NOT_YET_VALID');
  if (!verifyApproval(att)) throw new Error('APPROVAL_DENIED');
}

/**
 * Execute a mint from a verified attestation: verifies, consumes the nonce,
 * and records the mint. A second call with the same attestation throws
 * REPLAYED_NONCE — replay prevention.
 */
export function mintFromAttestation(
  state: ProofXState,
  att: Attestation,
  amount: bigint,
  verifyApproval: VerifyApprovalFn,
  now: number,
): ProofXState {
  if (amount <= 0n) throw new Error('MINT_AMOUNT_NON_POSITIVE');
  verifyAttestation(state, att, verifyApproval, now);
  return {
    ...state,
    usedNonces: [...state.usedNonces, att.nonce],
    minted: [
      ...state.minted,
      {
        attestationId: att.attestationId,
        subject: att.subject,
        amount,
        mintedAt: now,
        nonce: att.nonce,
        revoked: false,
      },
    ],
  };
}

/**
 * Revoke a previously accepted claim. Only `revocationAuthority` may call.
 * Sets the claim record's `revoked` flag — a registry flag ONLY. The minted
 * tokens are NOT burned or clawed back (mirrors on-chain `revoke_claim`).
 * Throws UNKNOWN_ATTESTATION if the attestation was never minted (on-chain
 * the claim account would not exist) and ALREADY_REVOKED on double revoke
 * (on-chain: ClaimRevoked).
 */
export function revokeAttestation(
  state: ProofXState,
  attestationId: string,
  revoker: string,
): ProofXState {
  if (state.config.revocationAuthority === null) throw new Error('ATTESTATIONS_IRREVOCABLE');
  if (revoker !== state.config.revocationAuthority) throw new Error('NOT_REVOCATION_AUTHORITY');
  const idx = state.minted.findIndex((m) => m.attestationId === attestationId);
  if (idx === -1) throw new Error('UNKNOWN_ATTESTATION');
  if (state.minted[idx].revoked) throw new Error('ALREADY_REVOKED');
  const minted = state.minted.map((m, i) => (i === idx ? { ...m, revoked: true } : m));
  return { ...state, minted };
}

export type AttestationStatus = 'valid' | 'revoked' | 'expired' | 'replayed' | 'unknown';

/** Read-only status check for the holder app's proof-status view. */
export function attestationStatus(
  state: ProofXState,
  attestationId: string,
  nonce: string | null,
  now: number,
): AttestationStatus {
  const record = state.minted.find((m) => m.attestationId === attestationId);
  if (record) return record.revoked ? 'revoked' : 'valid';
  if (nonce !== null && state.usedNonces.includes(nonce)) return 'replayed';
  void now;
  return 'unknown';
}

/** Human-readable verification mode — manual is never called automatic. */
export function verificationModeDescription(config: ProofXConfig): string {
  return config.automatic
    ? 'Automatic verification: an on-chain verifier program checks each attestation before minting. (Simulation: approval check is a stub.)'
    : 'Manual approval: a trusted verifier reviews each claim off-chain before signing. This is NOT automatic verification.';
}
