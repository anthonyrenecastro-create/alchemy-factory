/**
 * Attestation model for the `proofx` (Proof of X) mechanic.
 *
 * SIMULATION ONLY: pure functions, no chain state.
 *
 * Honesty rule: a manually approved claim is NEVER described as automatic
 * verification. `automatic: false` means a human (or off-chain process) signs
 * off; the UI must say so. Only `automatic: true` with a real verifier program
 * may be described as automatic — and in this simulation the signature check is
 * an injected stub, so the studio always labels it as simulated.
 *
 * Replay prevention: a nonce set. Each attestation carries a unique nonce;
 * once a nonce is consumed (mint executed), any reuse is rejected.
 * Revocation: a registry of revoked attestation IDs; revoked attestations can
 * never mint, even if previously valid.
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
  issuedAt: number;
  expiresAt: number;
  /** Base58 pubkey of the verifier that signed this attestation. */
  verifier: string;
}

export interface ProofXConfig {
  /** Base58 pubkeys trusted to issue attestations. */
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
}

export interface ProofXState {
  config: ProofXConfig;
  /** Consumed nonces — append-only. */
  usedNonces: string[];
  /** Revoked attestation IDs — append-only. */
  revokedIds: string[];
  minted: MintRecord[];
}

/** Injected signature check. In simulation this is a stub — labeled as such. */
export type VerifySignatureFn = (att: Attestation) => boolean;

export function createProofXState(config: ProofXConfig): ProofXState {
  if (config.trustedVerifiers.length === 0) throw new Error('NO_TRUSTED_VERIFIERS');
  return { config, usedNonces: [], revokedIds: [], minted: [] };
}

/**
 * Verify an attestation against the state. Returns silently on success; throws on:
 *  - UNTRUSTED_VERIFIER, REVOKED_ATTESTATION, REPLAYED_NONCE,
 *  - EXPIRED_ATTESTATION, NOT_YET_VALID, BAD_SIGNATURE.
 */
export function verifyAttestation(
  state: ProofXState,
  att: Attestation,
  verifySignature: VerifySignatureFn,
  now: number,
): void {
  if (!state.config.trustedVerifiers.includes(att.verifier)) throw new Error('UNTRUSTED_VERIFIER');
  if (state.revokedIds.includes(att.attestationId)) throw new Error('REVOKED_ATTESTATION');
  if (state.usedNonces.includes(att.nonce)) throw new Error('REPLAYED_NONCE');
  if (now > att.expiresAt) throw new Error('EXPIRED_ATTESTATION');
  if (now < att.issuedAt) throw new Error('NOT_YET_VALID');
  if (!verifySignature(att)) throw new Error('BAD_SIGNATURE');
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
  verifySignature: VerifySignatureFn,
  now: number,
): ProofXState {
  if (amount <= 0n) throw new Error('MINT_AMOUNT_NON_POSITIVE');
  verifyAttestation(state, att, verifySignature, now);
  return {
    ...state,
    usedNonces: [...state.usedNonces, att.nonce],
    minted: [...state.minted, { attestationId: att.attestationId, subject: att.subject, amount, mintedAt: now }],
  };
}

/** Revoke an attestation. Only `revocationAuthority` may call. */
export function revokeAttestation(
  state: ProofXState,
  attestationId: string,
  revoker: string,
): ProofXState {
  if (state.config.revocationAuthority === null) throw new Error('ATTESTATIONS_IRREVOCABLE');
  if (revoker !== state.config.revocationAuthority) throw new Error('NOT_REVOCATION_AUTHORITY');
  if (state.revokedIds.includes(attestationId)) return state;
  return { ...state, revokedIds: [...state.revokedIds, attestationId] };
}

export type AttestationStatus = 'valid' | 'revoked' | 'expired' | 'replayed' | 'unknown';

/** Read-only status check for the holder app's proof-status view. */
export function attestationStatus(
  state: ProofXState,
  attestationId: string,
  nonce: string | null,
  now: number,
): AttestationStatus {
  if (state.revokedIds.includes(attestationId)) return 'revoked';
  if (nonce !== null && state.usedNonces.includes(nonce)) return 'replayed';
  const record = state.minted.find((m) => m.attestationId === attestationId);
  if (record) return 'valid';
  void now;
  return 'unknown';
}

/** Human-readable verification mode — manual is never called automatic. */
export function verificationModeDescription(config: ProofXConfig): string {
  return config.automatic
    ? 'Automatic verification: an on-chain verifier program checks each attestation before minting. (Simulation: signature check is a stub.)'
    : 'Manual approval: a trusted verifier reviews each claim off-chain before signing. This is NOT automatic verification.';
}
