//! # alchemy_proofx — proof-of-X mechanic (Stage 2 stub)
//!
//! Planned behavior: minting from a *verifiable* attestation. Defines the
//! verifier, the evidence format, nonce-based replay prevention (one
//! [`ClaimRecord`] PDA per nonce), a revocation registry, the privacy
//! treatment of evidence, and a dispute process.
//!
//! A manually approved claim is never described as automatic verification: the
//! `verifier` key and `evidence_format_hash` are disclosed, and the holder app
//! shows whether verification was programmatic or human.
//!
//! Status: state structs, instruction signatures, and errors are defined;
//! instruction bodies are not yet implemented (Stage 2).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("ALCHproof11111111111111111111111111111111");

#[program]
pub mod alchemy_proofx {
    use super::*;

    /// Create the proof-of-X configuration for a Token-2022 mint.
    pub fn initialize_proofx(
        _ctx: Context<InitializeProofx>,
        _verifier: Pubkey,
        _evidence_format_hash: [u8; 32],
        _revocation_authority: Pubkey,
        _dispute_window_seconds: i64,
        _privacy_note_hash: [u8; 32],
    ) -> Result<()> {
        Err(ProofxError::NotImplemented.into())
    }

    /// Mint tokens against a verifier-signed attestation. The `nonce` must be
    /// unused (replay prevention); the attestation must be within the dispute
    /// window policy.
    pub fn mint_from_attestation(
        _ctx: Context<MintFromAttestation>,
        _attestation_hash: [u8; 32],
        _nonce: u64,
        _amount: u64,
    ) -> Result<()> {
        Err(ProofxError::NotImplemented.into())
    }

    /// Revoke a previously accepted claim. Only `revocation_authority`.
    pub fn revoke_claim(_ctx: Context<RevokeClaim>, _nonce: u64) -> Result<()> {
        Err(ProofxError::NotImplemented.into())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProofx<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = ProofxConfig::SPACE,
        seeds = [b"proofx", mint.key().as_ref()],
        bump,
    )]
    pub proofx_config: Account<'info, ProofxConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct MintFromAttestation<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(
        mut,
        seeds = [b"proofx", mint.key().as_ref()],
        bump = proofx_config.bump,
    )]
    pub proofx_config: Account<'info, ProofxConfig>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// Claimant's Token-2022 token account (created if needed).
    /// CHECK: Validated/created in the instruction body (Stage 2).
    #[account(mut)]
    pub claimant_token_account: UncheckedAccount<'info>,
    /// Replay-prevention record: one PDA per nonce. Re-initializing an
    /// existing nonce fails, which is what makes replay impossible.
    #[account(
        init,
        payer = claimant,
        space = ClaimRecord::SPACE,
        seeds = [b"claim", proofx_config.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,
    /// CHECK: The configured verifier; its signature over the attestation is
    /// verified in the instruction body (Stage 2).
    pub verifier: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RevokeClaim<'info> {
    pub revocation_authority: Signer<'info>,
    #[account(
        has_one = revocation_authority @ ProofxError::Unauthorized,
        seeds = [b"proofx", mint.key().as_ref()],
        bump = proofx_config.bump,
    )]
    pub proofx_config: Account<'info, ProofxConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [b"claim", proofx_config.key().as_ref(), &nonce.to_le_bytes()],
        bump = claim_record.bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct ProofxConfig {
    /// The Token-2022 mint governed by attestations.
    pub mint: Pubkey,
    /// Key whose signature makes an attestation valid. If this is a human
    /// operator, the UI must say "manually approved", never "automatically
    /// verified".
    pub verifier: Pubkey,
    /// SHA-256 of the evidence-format specification (off-chain document).
    pub evidence_format_hash: [u8; 32],
    /// May revoke accepted claims (e.g. fraud discovery).
    pub revocation_authority: Pubkey,
    /// Seconds after a claim during which it can be disputed.
    pub dispute_window_seconds: i64,
    /// SHA-256 of the privacy note explaining how evidence is treated
    /// (what is public, what stays off-chain).
    pub privacy_note_hash: [u8; 32],
    pub bump: u8,
}

impl ProofxConfig {
    /// 8 + 32 + 32 + 32 + 32 + 8 + 32 + 1.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 32 + 1;
}

/// One accepted attestation claim. The PDA seeds bind it to a single nonce,
/// so re-submitting the same nonce (replay) fails at account initialization.
#[account]
pub struct ClaimRecord {
    pub config: Pubkey,
    pub nonce: u64,
    pub claimant: Pubkey,
    pub attestation_hash: [u8; 32],
    pub amount: u64,
    pub created_ts: i64,
    pub revoked: bool,
    pub bump: u8,
}

impl ClaimRecord {
    /// 8 + 32 + 8 + 32 + 32 + 8 + 8 + 1 + 1.
    pub const SPACE: usize = 8 + 32 + 8 + 32 + 32 + 8 + 8 + 1 + 1;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ProofxInitialized {
    pub mint: Pubkey,
    pub verifier: Pubkey,
    pub revocation_authority: Pubkey,
}

#[event]
pub struct AttestationMinted {
    pub mint: Pubkey,
    pub claimant: Pubkey,
    pub nonce: u64,
    pub amount: u64,
}

#[event]
pub struct ClaimRevoked {
    pub mint: Pubkey,
    pub nonce: u64,
    pub revocation_authority: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ProofxError {
    #[msg("Not implemented yet (Stage 2).")]
    NotImplemented,
    #[msg("Caller is not authorized.")]
    Unauthorized,
    #[msg("This nonce was already used; the attestation is a replay.")]
    ReplayDetected,
    #[msg("This claim has been revoked.")]
    ClaimRevoked,
    #[msg("Attestation signature or format is invalid.")]
    InvalidAttestation,
    #[msg("The dispute window for this claim has elapsed.")]
    DisputeWindowElapsed,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
}
