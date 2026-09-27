//! # alchemy_decay — time-decaying mechanic (Stage 2)
//!
//! A creator configures a fixed expiration plus a separately specified
//! periodic decay schedule for a Token-2022 mint. The program is the
//! **deterministic schedule authority**: it records the schedule parameters,
//! who receives removed value, and how many decay periods have elapsed
//! (`total_periods_applied`, `last_decay_ts`).
//!
//! ## What this program does NOT do (honesty notes)
//!
//! - **No per-holder on-chain decay.** Reducing every holder's balance
//!   on-chain would require touching every token account each period, which
//!   is not implementable in a single permissionless crank. Instead,
//!   holders and the SDK compute decayed balances off-chain from the
//!   on-chain `total_periods_applied` and `last_decay_ts` (see
//!   `sdk/src/decay.ts`: `periodsElapsed` mirrors `apply_decay`'s period
//!   counting exactly, and `balanceAt` applies the floored per-period
//!   reduction).
//! - **No invented burns.** The program never burns or moves holder tokens.
//!   The removed-value `recipient` is recorded in the config and disclosed
//!   in every event; actual per-holder settlement of removed value is a
//!   display/integrator-layer concern.
//! - **Post-expiry flags are declarations, not enforcement.** The program has
//!   no transfer hook, so `transfers_allowed_after_expiry` and
//!   `redemption_allowed_after_expiry` cannot be enforced here. They are
//!   surfaced on-chain (config + events) for holders and integrators to
//!   honor. Any claim that this program blocks post-expiry transfers would
//!   be false.
//!
//! ## Schedule math
//!
//! `apply_decay` (permissionless crank) computes, with checked `i64` math:
//!
//! ```text
//! effective = min(now, expiry_ts)
//! periods   = floor((effective - last_decay_ts) / period_seconds)
//! ```
//!
//! It requires at least one full period ([`DecayError::DecayNotDue`]
//! otherwise), advances `last_decay_ts` by `periods * period_seconds`, and
//! bumps `total_periods_applied`. Capping at `expiry_ts` means no periods
//! accrue after expiry, and a second crank immediately after a capped one
//! always fails with `DecayNotDue`.
//!
//! ## Authorities (all explicit)
//!
//! - `authority`: admin — may rotate authority and close the config (after
//!   expiry only). Cannot change the schedule once initialized.
//! - The removed-value `recipient`: recorded at init; the crank rejects any
//!   other recipient account ([`DecayError::RecipientMismatch`]).
//! - Token-2022 only: every instruction rejects any other token program.
//!   Transfer hooks: **none**. Permanent delegate: **none**.
//!   Freeze authority: **none** (this program never touches token accounts).

use anchor_lang::prelude::*;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("HcXp2bp4ttC1wrzXfx6YJvdCKL6YhKgGEHiXAFNfwizD");

#[program]
pub mod alchemy_decay {
    use super::*;

    /// Create the decay configuration for a Token-2022 mint.
    ///
    /// Validates the schedule: `expiry_ts` must be strictly in the future
    /// (vs the clock sysvar), `period_seconds` must be positive,
    /// `decay_bps_per_period` must not exceed 10_000, and `recipient` must
    /// not be the default pubkey. Sets `last_decay_ts` to the current time.
    pub fn initialize_decay(
        ctx: Context<InitializeDecay>,
        expiry_ts: i64,
        decay_bps_per_period: u16,
        period_seconds: i64,
        recipient: Pubkey,
        transfers_allowed_after_expiry: bool,
        redemption_allowed_after_expiry: bool,
    ) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            DecayError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            DecayError::NotToken2022
        );

        let now = ctx.accounts.clock.unix_timestamp;
        require!(expiry_ts > now, DecayError::InvalidSchedule);
        require!(period_seconds > 0, DecayError::InvalidSchedule);
        require!(
            decay_bps_per_period <= 10_000,
            DecayError::InvalidSchedule
        );
        require!(
            recipient != Pubkey::default(),
            DecayError::InvalidSchedule
        );

        let config = &mut ctx.accounts.decay_config;
        config.mint = ctx.accounts.mint.key();
        config.authority = ctx.accounts.authority.key();
        config.expiry_ts = expiry_ts;
        config.decay_bps_per_period = decay_bps_per_period;
        config.period_seconds = period_seconds;
        config.recipient = recipient;
        config.transfers_allowed_after_expiry = transfers_allowed_after_expiry;
        config.redemption_allowed_after_expiry = redemption_allowed_after_expiry;
        config.last_decay_ts = now;
        config.total_periods_applied = 0;
        config.bump = ctx.bumps.decay_config;

        emit!(DecayInitialized {
            mint: config.mint,
            authority: config.authority,
            expiry_ts,
            decay_bps_per_period,
            period_seconds,
            recipient,
            transfers_allowed_after_expiry,
            redemption_allowed_after_expiry,
        });
        Ok(())
    }

    /// Permissionless crank: apply all decay periods elapsed since
    /// `last_decay_ts`, capped at `expiry_ts`.
    ///
    /// This instruction moves no tokens. It advances the deterministic
    /// schedule (`last_decay_ts`, `total_periods_applied`) and discloses the
    /// configured removed-value `recipient` in the emitted event. Holders
    /// and the SDK derive decayed balances from the on-chain counters.
    pub fn apply_decay(ctx: Context<ApplyDecay>) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            DecayError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            DecayError::NotToken2022
        );
        require!(
            ctx.accounts.recipient.key() == ctx.accounts.decay_config.recipient,
            DecayError::RecipientMismatch
        );

        let now = ctx.accounts.clock.unix_timestamp;
        let config = &ctx.accounts.decay_config;
        let effective = now.min(config.expiry_ts);
        let elapsed = effective
            .checked_sub(config.last_decay_ts)
            .ok_or(DecayError::MathOverflow)?;
        let periods_i64 = elapsed
            .checked_div(config.period_seconds)
            .ok_or(DecayError::MathOverflow)?;
        // A negative or zero elapsed time (clock skew, immediate re-crank,
        // or a fully capped schedule) means no full period elapsed.
        require!(periods_i64 >= 1, DecayError::DecayNotDue);

        let periods = u64::try_from(periods_i64).map_err(|_| DecayError::MathOverflow)?;
        let advance = periods_i64
            .checked_mul(config.period_seconds)
            .ok_or(DecayError::MathOverflow)?;

        let config = &mut ctx.accounts.decay_config;
        config.last_decay_ts = config
            .last_decay_ts
            .checked_add(advance)
            .ok_or(DecayError::MathOverflow)?;
        config.total_periods_applied = config
            .total_periods_applied
            .checked_add(periods)
            .ok_or(DecayError::MathOverflow)?;

        emit!(DecayApplied {
            mint: config.mint,
            periods_applied: periods,
            total_periods_applied: config.total_periods_applied,
            last_decay_ts: config.last_decay_ts,
            recipient: config.recipient,
        });
        Ok(())
    }

    /// Rotate the admin authority. Authority only. Emits the change.
    ///
    /// The default pubkey is rejected as the new authority: rotating to it
    /// would permanently brick admin (no key can ever sign as the default
    /// pubkey).
    pub fn update_decay_authority(
        ctx: Context<DecayAdmin>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            DecayError::InvalidAuthority
        );
        let old = ctx.accounts.decay_config.authority;
        ctx.accounts.decay_config.authority = new_authority;
        emit!(DecayAuthorityUpdated {
            mint: ctx.accounts.decay_config.mint,
            old_authority: old,
            new_authority,
        });
        Ok(())
    }

    /// Close the decay config after expiry, sending its rent lamports to the
    /// configured removed-value `recipient`. Authority only.
    ///
    /// Rejected before `expiry_ts` ([`DecayError::NotExpired`]): the schedule
    /// must remain readable on-chain for the token's whole lifetime.
    ///
    /// Also rejected while any full decay period between `last_decay_ts` and
    /// `expiry_ts` remains unapplied ([`DecayError::ScheduleNotSettled`]):
    /// the authority must run a final crank first. Otherwise closing could
    /// truncate the on-chain schedule record — `total_periods_applied`
    /// would permanently undercount the true schedule, stranding disclosure
    /// of the removed-value tail.
    pub fn close_decay(ctx: Context<CloseDecay>) -> Result<()> {
        require!(
            ctx.accounts.recipient.key() == ctx.accounts.decay_config.recipient,
            DecayError::RecipientMismatch
        );
        let now = ctx.accounts.clock.unix_timestamp;
        require!(
            now >= ctx.accounts.decay_config.expiry_ts,
            DecayError::NotExpired
        );
        // The schedule must be fully settled: no full period may remain
        // between last_decay_ts and expiry_ts. (last_decay_ts never exceeds
        // expiry_ts — the crank caps at expiry — so a non-positive numerator
        // also passes.)
        let unsettled_periods = ctx.accounts.decay_config.expiry_ts
            .checked_sub(ctx.accounts.decay_config.last_decay_ts)
            .ok_or(DecayError::MathOverflow)?
            .checked_div(ctx.accounts.decay_config.period_seconds)
            .ok_or(DecayError::MathOverflow)?;
        require!(unsettled_periods <= 0, DecayError::ScheduleNotSettled);

        emit!(DecayClosed {
            mint: ctx.accounts.decay_config.mint,
            authority: ctx.accounts.decay_config.authority,
            recipient: ctx.accounts.decay_config.recipient,
            total_periods_applied: ctx.accounts.decay_config.total_periods_applied,
            closed_at: now,
        });
        // The `close = recipient` constraint on the accounts struct reclaims
        // the account's lamports to the recipient after this body returns.
        Ok(())
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
    pub clock: Sysvar<'info, Clock>,
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
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Receives no funds from this instruction; must equal
    /// `decay_config.recipient` so events always disclose the true
    /// removed-value recipient.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

/// Shared admin context: every instruction here requires the current authority.
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

#[derive(Accounts)]
pub struct CloseDecay<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ DecayError::Unauthorized,
        seeds = [b"decay", mint.key().as_ref()],
        bump = decay_config.bump,
        close = recipient,
    )]
    pub decay_config: Account<'info, DecayConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Receives the reclaimed rent lamports; must equal
    /// `decay_config.recipient`.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub clock: Sysvar<'info, Clock>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct DecayConfig {
    /// The Token-2022 mint subject to decay/expiry.
    pub mint: Pubkey,
    /// Admin authority: authority rotation and post-expiry close only. The
    /// schedule itself is immutable once initialized.
    pub authority: Pubkey,
    /// Unix timestamp after which the token is expired.
    pub expiry_ts: i64,
    /// Decay applied per period, in basis points of the balance at period start.
    pub decay_bps_per_period: u16,
    /// Seconds per decay period.
    pub period_seconds: i64,
    /// Who receives removed value (recorded and disclosed; per-holder
    /// settlement is a display/integrator-layer concern — this program
    /// never moves holder tokens).
    pub recipient: Pubkey,
    /// Whether plain transfers remain possible after `expiry_ts`.
    /// Declaration only: without a transfer hook this program cannot
    /// enforce it; integrators must honor it.
    pub transfers_allowed_after_expiry: bool,
    /// Whether redemption remains possible after `expiry_ts`.
    /// Declaration only, like the transfers flag above.
    pub redemption_allowed_after_expiry: bool,
    /// Last timestamp decay was applied through (advanced by the crank).
    pub last_decay_ts: i64,
    /// Total decay periods applied across all cranks (monotonic).
    pub total_periods_applied: u64,
    pub bump: u8,
}

impl DecayConfig {
    /// 8 + 32 + 32 + 8 + 2 + 8 + 32 + 1 + 1 + 8 + 8 + 1.
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 2 + 8 + 32 + 1 + 1 + 8 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Events (emitted on every state change)
// ---------------------------------------------------------------------------

#[event]
pub struct DecayInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub expiry_ts: i64,
    pub decay_bps_per_period: u16,
    pub period_seconds: i64,
    pub recipient: Pubkey,
    pub transfers_allowed_after_expiry: bool,
    pub redemption_allowed_after_expiry: bool,
}

#[event]
pub struct DecayApplied {
    pub mint: Pubkey,
    /// Periods applied by this crank call.
    pub periods_applied: u64,
    /// Lifetime periods applied (monotonic on-chain counter).
    pub total_periods_applied: u64,
    /// `last_decay_ts` after this crank.
    pub last_decay_ts: i64,
    /// The configured removed-value recipient (disclosed, not paid here).
    pub recipient: Pubkey,
}

#[event]
pub struct DecayAuthorityUpdated {
    pub mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct DecayClosed {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub recipient: Pubkey,
    pub total_periods_applied: u64,
    pub closed_at: i64,
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
    #[msg("This program only operates with the Token-2022 program.")]
    NotToken2022,
    #[msg("The token has not expired yet; the decay config cannot be closed before expiry.")]
    NotExpired,
    #[msg("New authority must not be the default pubkey (it would brick admin).")]
    InvalidAuthority,
    #[msg("The decay schedule is not fully settled: crank the remaining periods before closing.")]
    ScheduleNotSettled,
}
