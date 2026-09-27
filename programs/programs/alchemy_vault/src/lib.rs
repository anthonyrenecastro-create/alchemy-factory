//! # alchemy_vault — PAXG collateral module (Stage 3 stub)
//!
//! Planned behavior: a segregated on-chain vault for an optional collateral
//! asset (PAXG on mainnet after the official Paxos Solana mint address is
//! verified; an unmistakably labeled mock asset on devnet).
//!
//! Enforced invariants (Stage 3):
//! - Actual deposited collateral >= outstanding contractual collateral claims.
//! - Mint/redemption amounts derived from vault assets and outstanding shares,
//!   with defined rounding and fees.
//! - Independent read-only proof of vault balance, liabilities, collateral
//!   ratio, and authority configuration ([`VaultProof`]).
//! - Withdrawal limits that preserve solvency.
//! - Explicit treatment of issuer controls (freeze authority on the collateral
//!   mint), bridging, market price changes, and Paxos redemption eligibility.
//!
//! The UI displays a *calculated* collateral value / redemption claim — never
//! a guaranteed market-price floor. Mock collateral is rejected anywhere real
//! PAXG is expected ([`VaultError::MockAssetMisuse`]).
//!
//! Status: state structs, instruction signatures, and errors are defined;
//! instruction bodies are not yet implemented (Stage 3).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

declare_id!("Fm6Uh2nzTnWXtXhR3B76BndV4s4kiBRA9fEv7BskDgHx");

/// Max bytes for the mock-asset label (e.g. "MOCK-GOLD — NOT PAXG").
pub const MAX_MOCK_LABEL_LEN: usize = 64;

#[program]
pub mod alchemy_vault {
    use super::*;

    /// Create a segregated vault for `collateral_mint`, with a share mint
    /// representing pro-rata claims. `is_mock_collateral` must be true on
    /// devnet; the label must make the mock nature unmistakable.
    pub fn initialize_vault(
        _ctx: Context<InitializeVault>,
        _collateral_mint: Pubkey,
        _withdrawal_limit_bps: u16,
        _is_mock_collateral: bool,
        _mock_label: String,
    ) -> Result<()> {
        Err(VaultError::NotImplemented.into())
    }

    /// Deposit collateral; receive newly minted shares pro-rata.
    pub fn deposit_collateral(_ctx: Context<DepositCollateral>, _amount: u64) -> Result<()> {
        Err(VaultError::NotImplemented.into())
    }

    /// Burn shares; receive the pro-rata collateral minus fees, subject to
    /// the withdrawal limit and the solvency invariant.
    pub fn redeem_shares(_ctx: Context<RedeemShares>, _shares: u64) -> Result<()> {
        Err(VaultError::NotImplemented.into())
    }

    /// Publish a read-only [`VaultProof`] snapshot anyone can verify.
    pub fn publish_proof(_ctx: Context<PublishProof>) -> Result<()> {
        Err(VaultError::NotImplemented.into())
    }

    /// Rotate the vault authority. Current authority only.
    pub fn update_vault_authority(
        _ctx: Context<VaultAdmin>,
        _new_authority: Pubkey,
    ) -> Result<()> {
        Err(VaultError::NotImplemented.into())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(mock_label: String)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = VaultConfig::SPACE,
        seeds = [b"vault", collateral_mint.key().as_ref()],
        bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    /// The collateral mint (real PAXG only after Paxos verification; mock on devnet).
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    /// Share mint: created by this instruction, mint authority = vault PDA.
    /// CHECK: Created in the instruction body (Stage 3).
    #[account(mut)]
    pub share_mint: UncheckedAccount<'info>,
    /// CHECK: Vault's collateral token account (PDA-owned); created in body.
    #[account(mut)]
    pub vault_collateral_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault_config.collateral_mint.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub depositor_collateral_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Vault's collateral token account.
    #[account(mut)]
    pub vault_collateral_account: UncheckedAccount<'info>,
    #[account(mut)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Depositor's share token account (created if needed in body).
    #[account(mut)]
    pub depositor_share_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RedeemShares<'info> {
    #[account(mut)]
    pub redeemer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", vault_config.collateral_mint.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub redeemer_share_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub share_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Vault's collateral token account.
    #[account(mut)]
    pub vault_collateral_account: UncheckedAccount<'info>,
    /// CHECK: Redeemer's collateral token account.
    #[account(mut)]
    pub redeemer_collateral_account: UncheckedAccount<'info>,
    /// CHECK: Fee recipient.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PublishProof<'info> {
    #[account(mut)]
    pub publisher: Signer<'info>,
    #[account(
        seeds = [b"vault", vault_config.collateral_mint.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
    /// CHECK: Read-only proof snapshot PDA; (re)created by this instruction.
    #[account(mut)]
    pub proof: UncheckedAccount<'info>,
    /// CHECK: Vault's collateral token account (read).
    pub vault_collateral_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct VaultAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ VaultError::Unauthorized,
        seeds = [b"vault", vault_config.collateral_mint.as_ref()],
        bump = vault_config.bump,
    )]
    pub vault_config: Account<'info, VaultConfig>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
pub struct VaultConfig {
    /// Collateral mint accepted by this vault.
    pub collateral_mint: Pubkey,
    /// Share mint representing pro-rata collateral claims.
    pub share_mint: Pubkey,
    /// Admin authority.
    pub authority: Pubkey,
    /// Fee recipient.
    pub treasury: Pubkey,
    /// Total collateral units held (bookkeeping; verified against the token account).
    pub total_collateral: u64,
    /// Total outstanding shares.
    pub total_shares: u64,
    /// Max fraction of the vault withdrawable per redemption, in bps.
    pub withdrawal_limit_bps: u16,
    /// True on devnet: the collateral is a mock asset, never real PAXG.
    pub is_mock_collateral: bool,
    /// Unmistakable label, e.g. "MOCK-GOLD — NOT PAXG, NO VALUE".
    pub mock_label: String,
    pub bump: u8,
}

impl VaultConfig {
    /// 8 + 32*4 + 8 + 8 + 2 + 1 + (4 + 64) + 1.
    pub const SPACE: usize = 8 + 32 * 4 + 8 + 8 + 2 + 1 + (4 + MAX_MOCK_LABEL_LEN) + 1;
}

/// Independent, read-only proof snapshot: balance, liabilities, ratio,
/// authority configuration. Published on demand; anyone can recompute it.
#[account]
pub struct VaultProof {
    pub vault: Pubkey,
    /// Collateral units in the vault token account at publish time.
    pub total_collateral: u64,
    /// Outstanding contractual claims (shares converted at current ratio).
    pub outstanding_claims: u64,
    /// total_collateral * 10000 / outstanding_claims; u64::MAX if no claims.
    pub collateral_ratio_bps: u64,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub is_mock_collateral: bool,
    pub published_ts: i64,
}

impl VaultProof {
    /// 8 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 8.
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 8;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct VaultInitialized {
    pub collateral_mint: Pubkey,
    pub share_mint: Pubkey,
    pub authority: Pubkey,
    pub is_mock_collateral: bool,
}

#[event]
pub struct CollateralDeposited {
    pub collateral_mint: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct SharesRedeemed {
    pub collateral_mint: Pubkey,
    pub redeemer: Pubkey,
    pub shares_burned: u64,
    pub collateral_out: u64,
    pub fee: u64,
}

#[event]
pub struct ProofPublished {
    pub collateral_mint: Pubkey,
    pub collateral_ratio_bps: u64,
    pub published_ts: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("Not implemented yet (Stage 3).")]
    NotImplemented,
    #[msg("Caller is not the vault authority.")]
    Unauthorized,
    #[msg("Operation would leave collateral below outstanding claims (insolvent).")]
    Insolvent,
    #[msg("Redemption exceeds the withdrawal limit that preserves solvency.")]
    WithdrawalLimitExceeded,
    #[msg("Collateral mint is not accepted by this vault.")]
    InvalidCollateralMint,
    #[msg("Mock collateral was presented where the real asset is required.")]
    MockAssetMisuse,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
    #[msg("Fee or limit basis points must not exceed 10000.")]
    InvalidBps,
}
