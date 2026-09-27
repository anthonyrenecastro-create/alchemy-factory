//! # alchemy_dynamic — dynamic/evolving mechanic (Stage 2 stub)
//!
//! Planned behavior: metadata/supply changes in response to authenticated
//! data ingested through an oracle adapter. Records the data source, update
//! authority, maximum supply, update frequency, stale-data behavior, and a
//! complete on-chain change history (one [`UpdateRecord`] PDA per update).
//!
//! An off-chain data source is never described as decentralized merely because
//! its result is written on-chain: the `data_source_name` and
//! `oracle_adapter` are disclosed verbatim.
//!
//! Status: state structs, instruction signatures, and errors are defined;
//! instruction bodies are not yet implemented (Stage 2).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("ALCHdynmc111111111111111111111111111111111");

/// Max bytes for the human-readable data-source name.
pub const MAX_SOURCE_NAME_LEN: usize = 64;

#[program]
pub mod alchemy_dynamic {
    use super::*;

    /// Create the dynamic configuration for a Token-2022 mint.
    pub fn initialize_dynamic(
        _ctx: Context<InitializeDynamic>,
        _max_supply: u64,
        _update_frequency_seconds: i64,
        _stale_threshold_seconds: i64,
        _data_source_name: String,
        _oracle_adapter: Pubkey,
    ) -> Result<()> {
        Err(DynamicError::NotImplemented.into())
    }

    /// Ingest one authenticated data point. Only `update_authority` may call;
    /// enforces `update_frequency_seconds` spacing and appends an
    /// [`UpdateRecord`] to the on-chain history.
    pub fn ingest_update(
        _ctx: Context<IngestUpdate>,
        _value: u64,
        _source_hash: [u8; 32],
    ) -> Result<()> {
        Err(DynamicError::NotImplemented.into())
    }

    /// Rotate the update authority. Current update authority only.
    pub fn update_dynamic_authority(
        _ctx: Context<DynamicAdmin>,
        _new_authority: Pubkey,
    ) -> Result<()> {
        Err(DynamicError::NotImplemented.into())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(data_source_name: String)]
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
#[instruction(value: u64)]
pub struct IngestUpdate<'info> {
    pub update_authority: Signer<'info>,
    #[account(
        mut,
        has_one = update_authority @ DynamicError::Unauthorized,
        seeds = [b"dynamic", mint.key().as_ref()],
        bump = dynamic_config.bump,
    )]
    pub dynamic_config: Account<'info, DynamicConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// History record PDA, created by this instruction.
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
    pub bump: u8,
}

impl DynamicConfig {
    /// 8 + 32 + 32 + 32 + (4 + 64) + 8 + 8 + 8 + 8 + 8 + 8 + 1.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + (4 + MAX_SOURCE_NAME_LEN) + 8 + 8 + 8 + 8 + 8 + 8 + 1;
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
// Events
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
}
