import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProofXState, mintFromAttestation, revokeAttestation, attestationStatus,
  verificationModeDescription, type ProofXConfig, type Attestation,
} from '../proofx.js';

const VERIFIER = 'Verifier111111111111111111111111111111111';
const SUBJECT = 'Holder11111111111111111111111111111111111';
const REVOKER = 'RevokeAuth1111111111111111111111111111111';

const cfg: ProofXConfig = {
  trustedVerifiers: [VERIFIER],
  evidenceFormat: 'sha256-of-signed-completion-certificate',
  replayPrevention: 'nonce-set',
  revocationAuthority: REVOKER,
  disputeProcess: 'Email disputes@ with evidence hash; 14-day review.',
  privacyTreatment: 'Only the evidence hash is stored; raw evidence stays off-chain.',
  automatic: false, // manual approval
};

const att: Attestation = {
  attestationId: 'att-1',
  subject: SUBJECT,
  claimType: 'completed-course:alchemy-101',
  evidenceHash: 'ab'.repeat(32),
  nonce: 'nonce-1',
  issuedAt: 1000,
  expiresAt: 2000,
  verifier: VERIFIER,
};

const goodApproval = () => true;

describe('proof-of-x minting (authority-signed attestation model)', () => {
  it('mints from a valid attestation and consumes the nonce', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    assert.equal(s.minted.length, 1);
    assert.ok(s.usedNonces.includes('nonce-1'));
    const rec = s.minted[0];
    assert.equal(rec.attestationId, 'att-1');
    assert.equal(rec.nonce, 'nonce-1');
    assert.equal(rec.subject, SUBJECT);
    assert.equal(rec.amount, 100n);
    assert.equal(rec.revoked, false);
    assert.equal(attestationStatus(s, 'att-1', null, 1500), 'valid');
  });

  it('REJECTS replay: same nonce cannot mint twice', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    assert.throws(
      () => mintFromAttestation(s, { ...att, attestationId: 'att-2' }, 50n, goodApproval, 1500),
      /REPLAYED_NONCE/,
    );
  });

  it('rejects untrusted verifier, expired, not-yet-valid, denied approval, non-positive amount', () => {
    const s = createProofXState(cfg);
    assert.throws(
      () => mintFromAttestation(s, { ...att, verifier: 'Evil11111111111111111111111111111111111' }, 1n, goodApproval, 1500),
      /UNTRUSTED_VERIFIER/,
    );
    assert.throws(() => mintFromAttestation(s, att, 1n, goodApproval, 2500), /EXPIRED_ATTESTATION/);
    assert.throws(() => mintFromAttestation(s, att, 1n, goodApproval, 500), /NOT_YET_VALID/);
    assert.throws(() => mintFromAttestation(s, att, 1n, () => false, 1500), /APPROVAL_DENIED/);
    assert.throws(() => mintFromAttestation(s, att, 0n, goodApproval, 1500), /MINT_AMOUNT_NON_POSITIVE/);
  });

  it('revocation sets a flag on the claim record; minted tokens are NOT burned', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    s = revokeAttestation(s, 'att-1', REVOKER);
    // The mint record survives revocation — the flag is registry-only.
    assert.equal(s.minted.length, 1);
    assert.equal(s.minted[0].revoked, true);
    assert.equal(s.minted[0].amount, 100n);
    assert.equal(attestationStatus(s, 'att-1', null, 1500), 'revoked');
  });

  it('a revoked claim cannot re-mint: the nonce stays consumed', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    s = revokeAttestation(s, 'att-1', REVOKER);
    assert.throws(
      () => mintFromAttestation(s, { ...att, attestationId: 'att-1-retry' }, 1n, goodApproval, 1500),
      /REPLAYED_NONCE/,
    );
  });

  it('revocation is authority-gated and idempotent-safe', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    // Wrong revoker.
    assert.throws(() => revokeAttestation(s, 'att-1', 'SomeoneElse'), /NOT_REVOCATION_AUTHORITY/);
    // Unknown attestation (never minted) — on-chain the claim account would not exist.
    assert.throws(() => revokeAttestation(s, 'att-never-minted', REVOKER), /UNKNOWN_ATTESTATION/);
    // Proper revoke, then double revoke fails.
    s = revokeAttestation(s, 'att-1', REVOKER);
    assert.throws(() => revokeAttestation(s, 'att-1', REVOKER), /ALREADY_REVOKED/);
  });

  it('irrevocable config cannot revoke', () => {
    let s = createProofXState({ ...cfg, revocationAuthority: null });
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    assert.throws(() => revokeAttestation(s, 'att-1', 'anyone'), /ATTESTATIONS_IRREVOCABLE/);
  });

  it('manual approval is never described as automatic', () => {
    const desc = verificationModeDescription(cfg);
    assert.ok(desc.includes('Manual approval'));
    assert.ok(!desc.includes('Automatic verification'));
  });

  it('status transitions: unknown -> valid -> revoked', () => {
    let s = createProofXState(cfg);
    assert.equal(attestationStatus(s, 'att-1', null, 1500), 'unknown');
    s = mintFromAttestation(s, att, 100n, goodApproval, 1500);
    assert.equal(attestationStatus(s, 'att-1', 'nonce-1', 1500), 'valid');
    s = revokeAttestation(s, 'att-1', REVOKER);
    assert.equal(attestationStatus(s, 'att-1', 'nonce-1', 1500), 'revoked');
  });
});
