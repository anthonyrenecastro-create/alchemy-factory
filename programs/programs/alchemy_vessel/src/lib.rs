//! # alchemy_vessel — hierarchical/nested mechanic (Stage 2 stub)
//!
//! Planned behavior: a transferable container (PDA) representing a defined set
//! of assets. Records actual holdings (one [`VesselHolding`] PDA per asset
//! mint), the custody program, deposit/withdraw permissions, and documents
//! that transferring the container moves *all* of its holdings to the new
//! owner.
//!
//! Status: state structs, instruction signatures, and errors are defined;
//! instruction bodies are not yet implemented (Stage 2).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("ALCHvssl1111111111111111111111111111111111");

#[program]
pub mod alchemy_vessel {
    use super::*;

    /// Create a vessel container bound to a Token-2022 "container" mint.
    /// The `custody_program` that physically holds deposited assets is
    /// recorded on-chain and disclosed to holders.
    pub fn initialize_vessel(
        _ctx: Context<InitializeVessel>,
        _custody_program: Pubkey,
        _deposit_authority: Pubkey,
        _withdraw_authority: Pubkey,
    ) -> Result<()> {
        Err(VesselError::NotImplemented.into())
    }

    /// Deposit `amount` of an asset into the vessel. Only `deposit_authority`.
    pub fn deposit_asset(_ctx: Context<DepositAsset>, _amount: u64) -> Result<()> {
        Err(VesselError::NotImplemented.into())
    }

    /// Withdraw `amount` of an asset from the vessel. Only `withdraw_authority`.
    pub fn withdraw_asset(_ctx: Context<WithdrawAsset>, _amount: u64) -> Result<()> {
        Err(VesselError::NotImplemented.into())
    }

    /// Transfer container ownership to `new_owner`. All holdings recorded in
    /// [`VesselHolding`] accounts move with the container; the assets
    /// themselves never move.
    pub fn transfer_container(
        _ctx: Context<TransferContainer>,
        _new_owner: Pubkey,
    ) -> Result<()> {
        Err(VesselError::NotImplemented.into())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVessel<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = VesselConfig::SPACE,
        seeds = [b"vessel", container_mint.key().as_ref()],
        bump,
    )]
    pub vessel: Account<'info, VesselConfig>,
    /// The Token-2022 mint whose tokens represent container ownership shares.
    pub container_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositAsset<'info> {
    pub deposit_authority: Signer<'info>,
    #[account(
        mut,
        has_one = deposit_authority @ VesselError::Unauthorized,
        seeds = [b"vessel", container_mint.key().as_ref()],
        bump = vessel.bump,
    )]
    pub vessel: Account<'info, VesselConfig>,
    pub container_mint: InterfaceAccount<'info, Mint>,
    /// The asset mint being deposited.
    pub asset_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub depositor_asset_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Holding record PDA for (vessel, asset_mint); created if needed.
    #[account(mut)]
    pub holding: UncheckedAccount<'info>,
    /// CHECK: Custody account owned by `vessel.custody_program`.
    #[account(mut)]
    pub custody_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawAsset<'info> {
    pub withdraw_authority: Signer<'info>,
    #[account(
        mut,
        has_one = withdraw_authority @ VesselError::Unauthorized,
        seeds = [b"vessel", container_mint.key().as_ref()],
        bump = vessel.bump,
    )]
    pub vessel: Account<'info, VesselConfig>,
    pub container_mint: InterfaceAccount<'info, Mint>,
    pub asset_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Holding record PDA for (vessel, asset_mint).
    #[account(mut)]
    pub holding: UncheckedAccount<'info>,
    /// CHECK: Custody account owned by `vessel.custody_program`.
    #[account(mut)]
    pub custody_account: UncheckedAccount<'info>,
    /// CHECK: Destination token account for the withdrawn assets.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct TransferContainer<'info> {
    pub current_owner: Signer<'info>,
    #[account(
        mut,
        has_one = current_owner @ VesselError::Unauthorized,
        seeds = [b"vessel", container_mint.key().as_ref()],
        bump = vessel.bump,
    )]
    pub vessel: Account<'info, VesselConfig>,
    pub container_mint: InterfaceAccount<'info, Mint>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct VesselConfig {
    /// The Token-2022 mint whose tokens represent container ownership.
    pub container_mint: Pubkey,
    /// Current container owner. Transferring ownership moves all holdings.
    pub current_owner: Pubkey,
    /// Program that has custody of deposited assets (recorded + disclosed).
    pub custody_program: Pubkey,
    /// Only this key may deposit assets.
    pub deposit_authority: Pubkey,
    /// Only this key may withdraw assets.
    pub withdraw_authority: Pubkey,
    /// Number of distinct asset mints currently held.
    pub asset_count: u64,
    pub bump: u8,
}

impl VesselConfig {
    /// 8 + 32 * 5 + 8 + 1.
    pub const SPACE: usize = 8 + 32 * 5 + 8 + 1;
}

/// Actual holding of one asset mint inside a vessel.
#[account]
pub struct VesselHolding {
    pub vessel: Pubkey,
    pub asset_mint: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

impl VesselHolding {
    /// 8 + 32 + 32 + 8 + 1.
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct VesselInitialized {
    pub container_mint: Pubkey,
    pub current_owner: Pubkey,
    pub custody_program: Pubkey,
}

#[event]
pub struct AssetDeposited {
    pub container_mint: Pubkey,
    pub asset_mint: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AssetWithdrawn {
    pub container_mint: Pubkey,
    pub asset_mint: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct ContainerTransferred {
    pub container_mint: Pubkey,
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum VesselError {
    #[msg("Not implemented yet (Stage 2).")]
    NotImplemented,
    #[msg("Caller is not authorized for this vessel action.")]
    Unauthorized,
    #[msg("Asset is not held by this vessel.")]
    AssetNotHeld,
    #[msg("Vessel holding is insufficient for this withdrawal.")]
    InsufficientHoldings,
    #[msg("Custody program does not match the vessel configuration.")]
    InvalidCustodyProgram,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
}
