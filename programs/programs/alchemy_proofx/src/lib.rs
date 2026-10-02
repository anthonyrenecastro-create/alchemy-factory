//! # alchemy_proofx — proof-of-X mechanic (Stage 2)
//!
//! Minting from an **authority-signed attestation**.
//!
//! ## What an attestation is (honest definition)
//!
//! An attestation is the configured [`ProofxConfig::verifier`] key's
//! *signature on the `mint_from_attestation` transaction*. The verifier signs
//! over the instruction data (`attestation_hash`, `nonce`, `amount`) and the
//! accounts (`claimant`, config, mint), which binds the whole tuple: the
//! signature cannot be transplanted onto a different claimant, amount, or
//! nonce. There is no separate off-chain signature object for the program to
//! check — the transaction signature **is** the authorization.
//!
//! What the program does NOT do: it does not inspect evidence. Whatever
//! off-chain review the verifier performed (or skipped) before signing is
//! outside the program's view. If the verifier key belongs to a human
//! operator, the claim was **manually approved**; the holder app must say
//! exactly that — never "automatically verified". Only a verifier that is
//! itself an on-chain program performing checks could justify "automatic"
//! language, and even then the UI must state what was checked.
//!
//! ## Replay prevention
//!
//! One [`ClaimRecord`] PDA per nonce (`["claim", config, nonce]`), created
//! with `init`. Re-submitting the same nonce fails at account initialization
//! (the account already exists), so a replayed attestation cannot mint twice.
//! Note this surfaces as an account-initialization failure, not as
//! [`ProofxError::ReplayDetected`] — that variant is kept for API stability.
//!
//! ## Revocation
//!
//! [`revoke_claim`] sets a `revoked` flag on the claim record. It is a
//! **registry flag only**: it does not burn or claw back tokens already
//! minted. Burning would require the holder's cooperation (a `burn` signed by
//! the token owner) or a burn authority over the mint, which this program
//! deliberately does not take.
//!
//! ## Verifier rotation
//!
//! [`update_verifier`] lets the config `authority` rotate the verifier key.
//! This is the compromise-recovery path: a leaked or replaced verifier key is
//! revoked by rotation, after which signatures from the old key are rejected.
//!
//! ## Policy fields the program records but does not enforce
//!
//! `dispute_window_seconds`, `evidence_format_hash`, and `privacy_note_hash`
//! are disclosed on-chain so indexers and the holder app can display them, but
//! the program does not enforce attestation expiry or validate evidence
//! formats. Claims about enforcement must not exceed this.
//!
//! ## Token-2022 only
//!
//! Every instruction requires the Token-2022 program. The mint must be created
//! with the proofx-config PDA as its mint authority (checked in
//! `mint_from_attestation`, same pattern as `alchemy_curve`). The program
//! never creates the mint, takes no freeze authority, enables no transfer
//! hooks, and sets no permanent delegate — creators must disclose the mint's
//! actual extensions (see the Stage 2 compatibility checker).

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

declare_id!("GbohkenWuNxCZnzSkrMoJx17Uuc6nSjef5cYWgx9i71k");

#[program]
pub mod alchemy_proofx {
    use super::*;

    /// Create the proof-of-X configuration for a Token-2022 mint.
    ///
    /// Validation: `verifier` and `revocation_authority` must not be the
    /// default pubkey; `evidence_format_hash` and `privacy_note_hash` must be
    /// non-zero; `dispute_window_seconds` must be non-negative. The
    /// Token-2022 program is required.
    ///
    /// The mint's current mint authority MUST sign: only the mint's
    /// controller can publish the proofx config for it. Without this, anyone
    /// could squat the [`b"proofx"`, mint] PDA — pre-registering a config
    /// with their own verifier and authority — and permanently block the
    /// legitimate deployment, because there is no close or re-initialize
    /// path. (The squatted config could never mint, since
    /// [`mint_from_attestation`] requires the config PDA to be the mint
    /// authority, but it would brick the mint's proofx deployment forever.)
    ///
    /// The intended flow is: create the mint with yourself as mint authority
    /// → `initialize_proofx` (you sign as mint authority) → set the mint's
    /// authority to the config PDA.
    ///
    /// The initializer becomes the config `authority` and may later rotate
    /// the verifier via [`update_verifier`].
    ///
    /// Honesty note: the `verifier` key's *signature on the mint transaction*
    /// is what makes an attestation valid. If that key belongs to a human
    /// operator, the holder app must say "manually approved", never
    /// "automatically verified".
    pub fn initialize_proofx(
        ctx: Context<InitializeProofx>,
        verifier: Pubkey,
        evidence_format_hash: [u8; 32],
        revocation_authority: Pubkey,
        dispute_window_seconds: i64,
        privacy_note_hash: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            ProofxError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            ProofxError::NotToken2022
        );
        require!(
            verifier != Pubkey::default(),
            ProofxError::InvalidVerifier
        );
        require!(
            revocation_authority != Pubkey::default(),
            ProofxError::InvalidRevocationAuthority
        );
        require!(
            evidence_format_hash != [0u8; 32],
            ProofxError::InvalidEvidenceFormat
        );
        require!(
            privacy_note_hash != [0u8; 32],
            ProofxError::InvalidPrivacyNote
        );
        require!(
            dispute_window_seconds >= 0,
            ProofxError::InvalidDisputeWindow
        );
        // Anti-squatting: only the mint's current mint authority may publish
        // the config for it (see the doc comment on this instruction).
        require!(
            ctx.accounts.mint.mint_authority == Some(ctx.accounts.mint_authority.key()).into(),
            ProofxError::InvalidMintAuthority
        );

        let config = &mut ctx.accounts.proofx_config;
        config.mint = ctx.accounts.mint.key();
        config.authority = ctx.accounts.authority.key();
        config.verifier = verifier;
        config.evidence_format_hash = evidence_format_hash;
        config.revocation_authority = revocation_authority;
        config.dispute_window_seconds = dispute_window_seconds;
        config.privacy_note_hash = privacy_note_hash;
        config.bump = ctx.bumps.proofx_config;

        emit!(ProofxInitialized {
            mint: config.mint,
            verifier,
            revocation_authority,
        });
        Ok(())
    }

    /// Mint tokens against a verifier-signed attestation.
    ///
    /// The configured verifier must SIGN this transaction: their signature
    /// over the instruction data (`attestation_hash`, `nonce`, `amount`) and
    /// the accounts (`claimant`, config, mint) binds the whole tuple, so the
    /// signature cannot be replayed for a different claimant, amount, or
    /// nonce. This co-signature IS the attestation authorization — there is
    /// no separate off-chain signature for the program to verify, and the
    /// program does not inspect evidence (whatever review happened off-chain
    /// is outside its view).
    ///
    /// Replay prevention: the `claim_record` PDA (`["claim", config, nonce]`)
    /// is created with `init`. Re-submitting the same nonce fails at account
    /// initialization, so one attestation can never mint twice. This surfaces
    /// as an account-initialization failure, not as
    /// [`ProofxError::ReplayDetected`] (kept for API stability).
    ///
    /// The mint must have been created with the proofx-config PDA as its mint
    /// authority (same pattern as `alchemy_curve`); otherwise this fails with
    /// [`ProofxError::InvalidAttestation`].
    pub fn mint_from_attestation(
        ctx: Context<MintFromAttestation>,
        attestation_hash: [u8; 32],
        nonce: u64,
        amount: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            ProofxError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            ProofxError::NotToken2022
        );
        require!(amount > 0, ProofxError::ZeroAmount);
        require!(
            attestation_hash != [0u8; 32],
            ProofxError::InvalidAttestation
        );
        // The verifier account is a Signer (enforced by the type) and must be
        // the configured verifier (enforced by the constraint): the verifier
        // co-signing this transaction is the attestation authorization.
        // The mint must be governed by this program: the proofx-config PDA
        // must be its mint authority.
        require!(
            ctx.accounts.mint.mint_authority == Some(ctx.accounts.proofx_config.key()).into(),
            ProofxError::InvalidAttestation
        );

        // Mint to the claimant; the proofx-config PDA is the mint authority.
        let mint_key = ctx.accounts.mint.key();
        let config_bump = ctx.accounts.proofx_config.bump;
        let signer_seeds: &[&[u8]] = &[b"proofx", mint_key.as_ref(), &[config_bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.claimant_token_account.to_account_info(),
                    authority: ctx.accounts.proofx_config.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        let record = &mut ctx.accounts.claim_record;
        record.config = ctx.accounts.proofx_config.key();
        record.nonce = nonce;
        record.claimant = ctx.accounts.claimant.key();
        record.attestation_hash = attestation_hash;
        record.amount = amount;
        record.created_ts = ctx.accounts.clock.unix_timestamp;
        record.revoked = false;
        record.bump = ctx.bumps.claim_record;

        emit!(AttestationMinted {
            mint: mint_key,
            claimant: record.claimant,
            nonce,
            amount,
            attestation_hash,
        });
        Ok(())
    }

    /// Revoke a previously accepted claim. Only `revocation_authority`
    /// (enforced by `has_one`).
    ///
    /// Sets the claim record's `revoked` flag. This is a **registry flag
    /// only**: it does not burn or claw back tokens already minted. Burning
    /// would require the holder's cooperation (a `burn` signed by the token
    /// owner) or a burn authority over the mint, which this program
    /// deliberately does not take.
    pub fn revoke_claim(ctx: Context<RevokeClaim>, nonce: u64) -> Result<()> {
        require!(
            !ctx.accounts.claim_record.revoked,
            ProofxError::ClaimRevoked
        );
        ctx.accounts.claim_record.revoked = true;
        emit!(ClaimRevoked {
            mint: ctx.accounts.proofx_config.mint,
            // Identical to `claim_record.nonce` by PDA derivation; using the
            // instruction arg keeps the name bound for `#[instruction(nonce)]`.
            nonce,
            revocation_authority: ctx.accounts.proofx_config.revocation_authority,
        });
        Ok(())
    }

    /// Rotate the verifier key. Only the config `authority`.
    ///
    /// This is the compromise-recovery path: if the verifier key is leaked or
    /// the operator changes, the authority replaces it, and signatures from
    /// the old key are rejected from then on. Emits [`VerifierUpdated`].
    pub fn update_verifier(
        ctx: Context<UpdateVerifier>,
        new_verifier: Pubkey,
    ) -> Result<()> {
        require!(
            new_verifier != Pubkey::default(),
            ProofxError::InvalidVerifier
        );
        let old_verifier = ctx.accounts.proofx_config.verifier;
        ctx.accounts.proofx_config.verifier = new_verifier;
        emit!(VerifierUpdated {
            mint: ctx.accounts.proofx_config.mint,
            old_verifier,
            new_verifier,
        });
        Ok(())
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
    /// The mint's current mint authority. Must sign: only the mint's
    /// controller can publish the proofx config for it, which makes config
    /// squatting (an attacker pre-registering the config PDA for someone
    /// else's mint) impossible.
    pub mint_authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(attestation_hash: [u8; 32], nonce: u64, amount: u64)]
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
    /// The claimant's Token-2022 associated token account, created if needed.
    #[account(
        init_if_needed,
        payer = claimant,
        associated_token::mint = mint,
        associated_token::authority = claimant,
        associated_token::token_program = token_program,
    )]
    pub claimant_token_account: InterfaceAccount<'info, TokenAccount>,
    /// Replay-prevention record: one PDA per nonce. Re-initializing an
    /// existing nonce fails at account initialization, which is what makes
    /// replay impossible.
    #[account(
        init,
        payer = claimant,
        space = ClaimRecord::SPACE,
        seeds = [b"claim", proofx_config.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub claim_record: Account<'info, ClaimRecord>,
    /// The configured verifier. Must SIGN this transaction: the verifier's
    /// signature over this transaction's data and accounts IS the attestation
    /// authorization (see the module docs). If this key belongs to a human
    /// operator, the claim is manually approved — never "automatically
    /// verified".
    #[account(
        constraint = verifier.key() == proofx_config.verifier @ ProofxError::Unauthorized
    )]
    pub verifier: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
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

/// Rotate the verifier key. Only the config authority may call.
#[derive(Accounts)]
pub struct UpdateVerifier<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ ProofxError::Unauthorized,
        seeds = [b"proofx", mint.key().as_ref()],
        bump = proofx_config.bump,
    )]
    pub proofx_config: Account<'info, ProofxConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct ProofxConfig {
    /// The Token-2022 mint governed by attestations.
    pub mint: Pubkey,
    /// Admin authority: may rotate the verifier via `update_verifier`.
    /// Set to the initializer at creation.
    pub authority: Pubkey,
    /// Key whose signature on the mint transaction makes an attestation
    /// valid. If this is a human operator, the UI must say "manually
    /// approved", never "automatically verified".
    pub verifier: Pubkey,
    /// SHA-256 of the evidence-format specification (off-chain document).
    pub evidence_format_hash: [u8; 32],
    /// May revoke accepted claims (e.g. fraud discovery).
    pub revocation_authority: Pubkey,
    /// Seconds after a claim during which it can be disputed. Recorded as
    /// disclosed policy; the program does not enforce it.
    pub dispute_window_seconds: i64,
    /// SHA-256 of the privacy note explaining how evidence is treated
    /// (what is public, what stays off-chain).
    pub privacy_note_hash: [u8; 32],
    pub bump: u8,
}

impl ProofxConfig {
    /// 8 + 32 mint + 32 authority + 32 verifier + 32 evidence_format_hash
    ///   + 32 revocation_authority + 8 dispute_window_seconds
    ///   + 32 privacy_note_hash + 1 bump.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 32 + 8 + 32 + 1;
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
// Events (emitted on every state change)
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
    pub attestation_hash: [u8; 32],
}

#[event]
pub struct ClaimRevoked {
    pub mint: Pubkey,
    pub nonce: u64,
    pub revocation_authority: Pubkey,
}

#[event]
pub struct VerifierUpdated {
    pub mint: Pubkey,
    pub old_verifier: Pubkey,
    pub new_verifier: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors (variants are never removed; unused ones are kept for API stability)
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
    #[msg("This program only operates with the Token-2022 program.")]
    NotToken2022,
    #[msg("Verifier pubkey must not be the default pubkey.")]
    InvalidVerifier,
    #[msg("Revocation authority pubkey must not be the default pubkey.")]
    InvalidRevocationAuthority,
    #[msg("Evidence format hash must be non-zero.")]
    InvalidEvidenceFormat,
    #[msg("Privacy note hash must be non-zero.")]
    InvalidPrivacyNote,
    #[msg("Dispute window must be non-negative.")]
    InvalidDisputeWindow,
    #[msg("Only the mint's current mint authority may initialize the proofx config for it.")]
    InvalidMintAuthority,
}
