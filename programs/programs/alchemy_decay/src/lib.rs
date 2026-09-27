//! # alchemy_decay — time-decaying mechanic (Stage 2 stub)
//!
//! Planned behavior: fixed expiration plus a separately specified periodic
//! decay model. Records who receives removed value, how balances are
//! calculated, and whether transfers/redemption remain possible after expiry.
//!
//! Status: state structs, instruction signatures, and errors are defined;
//! instruction bodies are not yet implemented (Stage 2).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("ALCHdecay111111111111111111111111111111111");

#[program]
pub mod alchemy_decay {
    use super::*;

    /// Create the decay configuration for a Token-2022 mint.
    pub fn initialize_decay(
        _ctx: Context<InitializeDecay>,
        _expiry_ts: i64,
        _decay_bps_per_period: u16,
        _period_seconds: i64,
        _recipient: Pubkey,
        _transfers_allowed_after_expiry: bool,
        _redemption_allowed_after_expiry: bool,
    ) -> Result<()> {
        Err(DecayError::NotImplemented.into())
    }

    /// Permissionless crank: apply all decay periods elapsed since
    /// `last_decay_ts`, routing removed value to `recipient`.
    pub fn apply_decay(_ctx: Context<ApplyDecay>) -> Result<()> {
        Err(DecayError::NotImplemented.into())
    }

    /// Rotate the admin authority. Authority only.
    pub fn update_decay_authority(
        _ctx: Context<DecayAdmin>,
        _new_authority: Pubkey,
    ) -> Result<()> {
        Err(DecayError::NotImplemented.into())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeDecay<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = DecayConfig::SPACE,
        seeds = [b"decay", mint.key().as_ref()],
        bump,
    )]
    pub decay_config: Account<'info, DecayConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyDecay<'info> {
    /// Anyone may crank decay forward; math is fully determined on-chain.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"decay", mint.key().as_ref()],
        bump = decay_config.bump,
    )]
    pub decay_config: Account<'info, DecayConfig>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Receives removed value; must equal `decay_config.recipient`.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DecayAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ DecayError::Unauthorized,
        seeds = [b"decay", mint.key().as_ref()],
        bump = decay_config.bump,
    )]
    pub decay_config: Account<'info, DecayConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct DecayConfig {
    /// The Token-2022 mint subject to decay/expiry.
    pub mint: Pubkey,
    /// Admin authority.
    pub authority: Pubkey,
    /// Unix timestamp after which the token is expired.
    pub expiry_ts: i64,
    /// Decay applied per period, in basis points of the balance at period start.
    pub decay_bps_per_period: u16,
    /// Seconds per decay period.
    pub period_seconds: i64,
    /// Who receives removed value (burned value is re-minted here, or the
    /// account value is transferred to).
    pub recipient: Pubkey,
    /// Whether plain transfers remain possible after `expiry_ts`.
    pub transfers_allowed_after_expiry: bool,
    /// Whether redemption remains possible after `expiry_ts`.
    pub redemption_allowed_after_expiry: bool,
    /// Last timestamp decay was applied through.
    pub last_decay_ts: i64,
    pub bump: u8,
}

impl DecayConfig {
    /// 8 + 32 + 32 + 8 + 2 + 8 + 32 + 1 + 1 + 8 + 1.
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 2 + 8 + 32 + 1 + 1 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct DecayInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub expiry_ts: i64,
    pub decay_bps_per_period: u16,
    pub period_seconds: i64,
    pub recipient: Pubkey,
}

#[event]
pub struct DecayApplied {
    pub mint: Pubkey,
    pub periods_applied: u64,
    pub total_removed: u64,
    pub recipient: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum DecayError {
    #[msg("Not implemented yet (Stage 2).")]
    NotImplemented,
    #[msg("Caller is not the decay authority.")]
    Unauthorized,
    #[msg("Decay schedule parameters are invalid.")]
    InvalidSchedule,
    #[msg("The token is expired; this action is not allowed post-expiry.")]
    Expired,
    #[msg("No decay period has fully elapsed since the last application.")]
    DecayNotDue,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
    #[msg("Recipient account does not match the configured recipient.")]
    RecipientMismatch,
}
