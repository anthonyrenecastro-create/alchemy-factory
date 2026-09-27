import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProofXState, mintFromAttestation, revokeAttestation, attestationStatus,
  verificationModeDescription, type ProofXConfig, type Attestation,
} from '../proofx.js';

const VERIFIER = 'Verifier111111111111111111111111111111111';
const SUBJECT = 'Holder11111111111111111111111111111111111';

const cfg: ProofXConfig = {
  trustedVerifiers: [VERIFIER],
  evidenceFormat: 'sha256-of-signed-completion-certificate',
  replayPrevention: 'nonce-set',
  revocationAuthority: 'RevokeAuth1111111111111111111111111111111',
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

const goodSig = () => true;

describe('proof-of-x minting', () => {
  it('mints from a valid attestation and consumes the nonce', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodSig, 1500);
    assert.equal(s.minted.length, 1);
    assert.ok(s.usedNonces.includes('nonce-1'));
  });

  it('REJECTS replay: same nonce cannot mint twice', () => {
    let s = createProofXState(cfg);
    s = mintFromAttestation(s, att, 100n, goodSig, 1500);
    assert.throws(
      () => mintFromAttestation(s, { ...att, attestationId: 'att-2' }, 50n, goodSig, 1500),
      /REPLAYED_NONCE/,
    );
  });

  it('rejects untrusted verifier, expired, bad signature', () => {
    const s = createProofXState(cfg);
    assert.throws(() => mintFromAttestation(s, { ...att, verifier: 'Evil11111111111111111111111111111111111' }, 1n, goodSig, 1500), /UNTRUSTED_VERIFIER/);
    assert.throws(() => mintFromAttestation(s, att, 1n, goodSig, 2500), /EXPIRED_ATTESTATION/);
    assert.throws(() => mintFromAttestation(s, att, 1n, () => false, 1500), /BAD_SIGNATURE/);
  });

  it('revocation blocks minting; only the revocation authority may revoke', () => {
    let s = createProofXState(cfg);
    assert.throws(() => revokeAttestation(s, 'att-1', 'SomeoneElse'), /NOT_REVOCATION_AUTHORITY/);
    s = revokeAttestation(s, 'att-1', cfg.revocationAuthority!);
    assert.throws(() => mintFromAttestation(s, att, 1n, goodSig, 1500), /REVOKED_ATTESTATION/);
    assert.equal(attestationStatus(s, 'att-1', null, 1500), 'revoked');
  });

  it('irrevocable config cannot revoke', () => {
    const s = createProofXState({ ...cfg, revocationAuthority: null });
    assert.throws(() => revokeAttestation(s, 'att-1', 'anyone'), /ATTESTATIONS_IRREVOCABLE/);
  });

  it('manual approval is never described as automatic', () => {
    const desc = verificationModeDescription(cfg);
    assert.ok(desc.includes('Manual approval'));
    assert.ok(!desc.includes('Automatic verification'));
  });
});
