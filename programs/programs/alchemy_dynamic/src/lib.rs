//! # alchemy_dynamic — dynamic/evolving mechanic (Stage 2)
//!
//! A creator configures how a Token-2022 mint responds to authenticated
//! off-chain data ingested through an oracle adapter: a hard supply cap, a
//! minimum spacing between updates, and a staleness threshold. Every accepted
//! update appends one [`UpdateRecord`] PDA to a complete, append-only
//! on-chain history; records are never modified or deleted.
//!
//! ## What the program enforces (and what it does not)
//!
//! The program enforces *freshness* (no future timestamps, no stale-at-arrival
//! data), *monotonicity* (source timestamps strictly increase),
//! *frequency* (minimum spacing between accepted updates), and a hard *cap*
//! (`value <= max_supply`). It does **not** interpret `value`: the economic
//! meaning of the ingested number is experiment-defined and must be disclosed
//! to holders verbatim — the program checks the envelope, never the meaning.
//!
//! An off-chain data source is never described as decentralized merely because
//! its result is written on-chain: `data_source_name` and `oracle_adapter`
//! are disclosed verbatim.
//!
//! Until the first update lands, `last_value` / `last_update_ts` are zero and
//! consumers must treat the feed as stale (see `isStale` in the SDK).
//!
//! No transfer hooks, permanent delegates, or freeze authorities are touched
//! by this program.

use anchor_lang::prelude::*;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("GpyFdGCFshaNHvqnove6jBuxUjcC5jmTVeT2zpmaXWUY");

/// Max bytes for the human-readable data-source name.
pub const MAX_SOURCE_NAME_LEN: usize = 64;

#[program]
pub mod alchemy_dynamic {
    use super::*;

    /// Create the dynamic configuration for a Token-2022 mint.
    ///
    /// The signer becomes `update_authority`. No data has been ingested yet:
    /// `last_value` / `last_update_ts` start at zero and `update_count` at
    /// zero, so consumers must treat the feed as stale until the first
    /// [`ingest_update`](fn@ingest_update) lands.
    pub fn initialize_dynamic(
        ctx: Context<InitializeDynamic>,
        max_supply: u64,
        update_frequency_seconds: i64,
        stale_threshold_seconds: i64,
        data_source_name: String,
        oracle_adapter: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            DynamicError::NotToken2022
        );
        // The mint itself must be owned by the Token-2022 program: checking
        // only the passed `token_program` account is not enough, because
        // `InterfaceAccount<Mint>` also deserializes legacy SPL Token mints.
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            DynamicError::NotToken2022
        );
        require!(max_supply > 0, DynamicError::InvalidMaxSupply);
        require!(
            update_frequency_seconds > 0,
            DynamicError::InvalidUpdateFrequency
        );
        require!(
            stale_threshold_seconds > 0,
            DynamicError::InvalidStaleThreshold
        );
        require!(
            data_source_name.len() <= MAX_SOURCE_NAME_LEN,
            DynamicError::SourceNameTooLong
        );
        require!(
            oracle_adapter != Pubkey::default(),
            DynamicError::InvalidSource
        );

        let config = &mut ctx.accounts.dynamic_config;
        config.mint = ctx.accounts.mint.key();
        config.update_authority = ctx.accounts.authority.key();
        config.oracle_adapter = oracle_adapter;
        config.data_source_name = data_source_name;
        config.max_supply = max_supply;
        config.update_frequency_seconds = update_frequency_seconds;
        config.stale_threshold_seconds = stale_threshold_seconds;
        config.last_value = 0;
        config.last_update_ts = 0;
        config.update_count = 0;
        config.paused = false;
        config.bump = ctx.bumps.dynamic_config;

        emit!(DynamicInitialized {
            mint: config.mint,
            update_authority: config.update_authority,
            oracle_adapter: config.oracle_adapter,
            max_supply,
        });
        Ok(())
    }

    /// Ingest one authenticated data point. Only `update_authority` may call.
    ///
    /// Validation mirrors the SDK's `appendUpdate` exactly, in this order:
    /// 1. `source_ts` must not be in the future ([`DynamicError::FutureUpdate`]).
    /// 2. Stale-at-arrival data is never written ([`DynamicError::StaleData`]).
    /// 3. Timestamps must strictly increase ([`DynamicError::NonMonotonicUpdate`]).
    /// 4. Minimum `update_frequency_seconds` spacing ([`DynamicError::UpdateTooFrequent`]).
    /// 5. `value` must not exceed `max_supply` ([`DynamicError::MaxSupplyExceeded`]).
    ///
    /// The admin circuit breaker ([`pause_dynamic`](fn@pause_dynamic)) is
    /// checked before all of the above: a paused feed rejects every update
    /// with [`DynamicError::Paused`].
    ///
    /// On success the [`UpdateRecord`] PDA for this index is created and the
    /// config's `last_value` / `last_update_ts` / `update_count` advance.
    /// History is append-only: records are never modified or deleted.
    pub fn ingest_update(
        ctx: Context<IngestUpdate>,
        value: u64,
        source_ts: i64,
        source_hash: [u8; 32],
    ) -> Result<()> {
        // Copy everything needed out of the config first so the borrow ends
        // before the record/config are mutated below.
        let (paused, stale_threshold_seconds, update_count, last_update_ts, update_frequency_seconds, max_supply, mint, config_key) = {
            let cfg = &ctx.accounts.dynamic_config;
            (
                cfg.paused,
                cfg.stale_threshold_seconds,
                cfg.update_count,
                cfg.last_update_ts,
                cfg.update_frequency_seconds,
                cfg.max_supply,
                cfg.mint,
                cfg.key(),
            )
        };

        // Circuit breaker first: a paused feed rejects every update.
        require!(!paused, DynamicError::Paused);

        let now = ctx.accounts.clock.unix_timestamp;
        // 1. The source timestamp must not be in the future.
        require!(source_ts <= now, DynamicError::FutureUpdate);
        // 2. Stale-at-arrival data is never written.
        let age = now
            .checked_sub(source_ts)
            .ok_or(DynamicError::MathOverflow)?;
        require!(age <= stale_threshold_seconds, DynamicError::StaleData);
        // 3-4. Append-only history: timestamps strictly increase and respect
        // the minimum spacing. Skipped for the very first update (no last
        // timestamp exists yet).
        if update_count > 0 {
            require!(
                source_ts > last_update_ts,
                DynamicError::NonMonotonicUpdate
            );
            let gap = source_ts
                .checked_sub(last_update_ts)
                .ok_or(DynamicError::MathOverflow)?;
            require!(
                gap >= update_frequency_seconds,
                DynamicError::UpdateTooFrequent
            );
        }
        // 5. Hard cap on the ingested value.
        require!(value <= max_supply, DynamicError::MaxSupplyExceeded);

        let record = &mut ctx.accounts.update_record;
        record.config = config_key;
        record.index = update_count;
        record.value = value;
        record.source_hash = source_hash;
        record.ts = source_ts;

        let config = &mut ctx.accounts.dynamic_config;
        config.last_value = value;
        config.last_update_ts = source_ts;
        config.update_count = update_count
            .checked_add(1)
            .ok_or(DynamicError::MathOverflow)?;

        emit!(UpdateIngested {
            mint,
            index: update_count,
            value,
            source_hash,
            ts: source_ts,
        });
        Ok(())
    }

    /// Rotate the update authority. Current update authority only.
    ///
    /// The default pubkey is rejected as the new authority: rotating to it
    /// would permanently brick admin (pause could never be lifted, since no
    /// key can sign as the default pubkey).
    pub fn update_dynamic_authority(
        ctx: Context<DynamicAdmin>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            DynamicError::InvalidAuthority
        );
        let old = ctx.accounts.dynamic_config.update_authority;
        ctx.accounts.dynamic_config.update_authority = new_authority;
        emit!(DynamicAuthorityUpdated {
            mint: ctx.accounts.dynamic_config.mint,
            old_authority: old,
            new_authority,
        });
        Ok(())
    }

    /// Halt update ingestion. Current update authority only. While paused,
    /// [`ingest_update`](fn@ingest_update) rejects every update with
    /// [`DynamicError::Paused`]; history already written is unaffected.
    pub fn pause_dynamic(ctx: Context<DynamicAdmin>) -> Result<()> {
        ctx.accounts.dynamic_config.paused = true;
        emit!(DynamicPaused {
            mint: ctx.accounts.dynamic_config.mint,
        });
        Ok(())
    }

    /// Resume update ingestion. Current update authority only.
    pub fn unpause_dynamic(ctx: Context<DynamicAdmin>) -> Result<()> {
        ctx.accounts.dynamic_config.paused = false;
        emit!(DynamicUnpaused {
            mint: ctx.accounts.dynamic_config.mint,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(max_supply: u64, update_frequency_seconds: i64, stale_threshold_seconds: i64, data_source_name: String, oracle_adapter: Pubkey)]
pub struct InitializeDynamic<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = DynamicConfig::SPACE,
        seeds = [b"dynamic", mint.key().as_ref()],
        bump,
    )]
    pub dynamic_config: Account<'info, DynamicConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
#[instruction(value: u64, source_ts: i64, source_hash: [u8; 32])]
pub struct IngestUpdate<'info> {
    // The update authority pays for the new UpdateRecord account, so the
    // payer must be mutable (Anchor 0.31: "the payer specified for an init
    // constraint must be mutable").
    #[account(mut)]
    pub update_authority: Signer<'info>,
    #[account(
        mut,
        has_one = update_authority @ DynamicError::Unauthorized,
        seeds = [b"dynamic", mint.key().as_ref()],
        bump = dynamic_config.bump,
    )]
    pub dynamic_config: Account<'info, DynamicConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// History record PDA, created by this instruction. Append-only: the seed
    /// index is the pre-increment `update_count`, so each update gets exactly
    /// one record and records are never rewritten.
    #[account(
        init,
        payer = update_authority,
        space = UpdateRecord::SPACE,
        seeds = [b"update", dynamic_config.key().as_ref(), &dynamic_config.update_count.to_le_bytes()],
        bump,
    )]
    pub update_record: Account<'info, UpdateRecord>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct DynamicAdmin<'info> {
    pub update_authority: Signer<'info>,
    #[account(
        mut,
        has_one = update_authority @ DynamicError::Unauthorized,
        seeds = [b"dynamic", mint.key().as_ref()],
        bump = dynamic_config.bump,
    )]
    pub dynamic_config: Account<'info, DynamicConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct DynamicConfig {
    /// The Token-2022 mint governed by this config.
    pub mint: Pubkey,
    /// Only this key may ingest updates.
    pub update_authority: Pubkey,
    /// On-chain oracle adapter program/account data is read from.
    pub oracle_adapter: Pubkey,
    /// Human-readable name of the off-chain data source (e.g. "Chainlink
    /// SOL/USD feed via adapter X"). Never implied to be decentralized.
    pub data_source_name: String,
    /// Hard cap on supply; updates that would exceed it are rejected.
    pub max_supply: u64,
    /// Minimum seconds between accepted updates.
    pub update_frequency_seconds: i64,
    /// Seconds after `last_update_ts` at which consumers must treat data as stale.
    pub stale_threshold_seconds: i64,
    /// Last ingested value.
    pub last_value: u64,
    /// Unix timestamp of the last ingested update.
    pub last_update_ts: i64,
    /// Monotonic counter; also the seed index of the next [`UpdateRecord`].
    pub update_count: u64,
    /// Admin circuit breaker: while true, `ingest_update` rejects everything.
    pub paused: bool,
    pub bump: u8,
}

impl DynamicConfig {
    /// 8 + 32 + 32 + 32 + (4 + 64) + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1.
    pub const SPACE: usize =
        8 + 32 + 32 + 32 + (4 + MAX_SOURCE_NAME_LEN) + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1;
}

/// One entry of the complete on-chain change history.
#[account]
pub struct UpdateRecord {
    pub config: Pubkey,
    pub index: u64,
    pub value: u64,
    /// Hash of the source payload that produced this value.
    pub source_hash: [u8; 32],
    pub ts: i64,
}

impl UpdateRecord {
    /// 8 + 32 + 8 + 8 + 32 + 8.
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 32 + 8;
}

// ---------------------------------------------------------------------------
// Events (emitted on every state change)
// ---------------------------------------------------------------------------

#[event]
pub struct DynamicInitialized {
    pub mint: Pubkey,
    pub update_authority: Pubkey,
    pub oracle_adapter: Pubkey,
    pub max_supply: u64,
}

#[event]
pub struct UpdateIngested {
    pub mint: Pubkey,
    pub index: u64,
    pub value: u64,
    pub source_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct DynamicAuthorityUpdated {
    pub mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct DynamicPaused {
    pub mint: Pubkey,
}

#[event]
pub struct DynamicUnpaused {
    pub mint: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum DynamicError {
    #[msg("Not implemented yet (Stage 2).")]
    NotImplemented,
    #[msg("Caller is not the update authority.")]
    Unauthorized,
    #[msg("Update arrived sooner than update_frequency_seconds allows.")]
    UpdateTooFrequent,
    #[msg("Data is older than stale_threshold_seconds; consumers must treat it as stale.")]
    StaleData,
    #[msg("Update would exceed max_supply.")]
    MaxSupplyExceeded,
    #[msg("Oracle adapter or data source is not recognized.")]
    InvalidSource,
    #[msg("Data source name exceeds the maximum length.")]
    SourceNameTooLong,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
    #[msg("Update timestamp is in the future.")]
    FutureUpdate,
    #[msg("Update timestamp is not strictly after the last accepted update.")]
    NonMonotonicUpdate,
    #[msg("Update ingestion is paused.")]
    Paused,
    #[msg("max_supply must be greater than zero.")]
    InvalidMaxSupply,
    #[msg("update_frequency_seconds must be greater than zero.")]
    InvalidUpdateFrequency,
    #[msg("stale_threshold_seconds must be greater than zero.")]
    InvalidStaleThreshold,
    #[msg("This program only operates with the Token-2022 program.")]
    NotToken2022,
    #[msg("New authority must not be the default pubkey (it would brick admin).")]
    InvalidAuthority,
}
