//! # alchemy_vessel — hierarchical/nested mechanic (Stage 2)
//!
//! A transferable container (PDA) over a defined set of Token-2022 assets.
//! Each vessel records one [`VesselHolding`] PDA per asset mint — the
//! on-chain ledger of what the vessel holds.
//!
//! ## Custody model (v1)
//!
//! The vessel PDA itself custodies the assets. For every (vessel, asset mint)
//! pair there is a custody token-account PDA with seeds
//! `[b"custody", vessel, asset_mint]`: a Token-2022 token account whose
//! authority is the vessel PDA. Deposits move tokens from the depositor into
//! this account; withdrawals move them out, signed by the vessel PDA.
//!
//! `custody_program` records the token program that physically holds the
//! assets and is disclosed to holders verbatim. In v1 it is pinned to the
//! Token-2022 program ID: [`initialize_vessel`] rejects any other value, so
//! the recorded value always matches reality.
//!
//! ## Holding invariant
//!
//! After every deposit and withdrawal the program asserts
//! `holding.amount == custody_token_account.amount` and fails with
//! [`VesselError::HoldingMismatch`] otherwise. The ledger can therefore never
//! drift from the tokens actually sitting in custody.
//!
//! ## Roles (all explicit)
//!
//! - `current_owner`: owns the container. [`transfer_container`] rotates this
//!   key. All [`VesselHolding`] records move with the container; the
//!   underlying assets never move.
//! - `deposit_authority`: the only signer that may call [`deposit_asset`].
//! - `withdraw_authority`: the only signer that may call [`withdraw_asset`].
//!
//! The two authorities are independent roles: they may be the same key or
//! different keys, and transferring container ownership does NOT rotate them.
//! The new owner gains no deposit/withdraw power from the transfer alone.
//!
//! ## Zero-balance holdings
//!
//! A holding record is never closed: withdrawing the full balance leaves a
//! zero-amount [`VesselHolding`] in place. This keeps the per-(vessel, asset)
//! history simple and makes `asset_count` a stable count of distinct asset
//! mints ever registered.
//!
//! ## Security notes (v1, not audited)
//!
//! - Token-2022 only: every token account and the `token_program` are
//!   verified against the Token-2022 program ID. This program adds no
//!   transfer hooks, permanent delegates, or other extensions.
//! - Asset mints are arbitrary Token-2022 mints and may carry extensions
//!   (e.g. transfer hooks) defined by their creators; deposits and
//!   withdrawals execute those extensions exactly as the mint defines them.
//! - Do not transfer tokens directly to a custody PDA: only [`deposit_asset`]
//!   keeps the holding ledger consistent. A direct transfer desynchronizes
//!   the ledger, and v1 has no sweep/adopt instruction, so deposits and
//!   withdrawals for that asset would fail with
//!   [`VesselError::HoldingMismatch`].
//! - `init_if_needed` creates the holding and custody PDAs on first deposit;
//!   the deposit authority pays the rent for first-time creation.

use anchor_lang::prelude::*;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

declare_id!("GDKMx2kuStLK64X2YSMnhbS8EPmpruDQoyXvoKzsTa6v");

#[program]
pub mod alchemy_vessel {
    use super::*;

    /// Create a vessel container bound to a Token-2022 `container_mint`.
    ///
    /// The signer becomes `current_owner`. In v1 the vessel PDA itself
    /// custodies deposited assets in PDA-owned Token-2022 token accounts, so
    /// `custody_program` must be the Token-2022 program ID; it is recorded
    /// on-chain and disclosed to holders verbatim.
    pub fn initialize_vessel(
        ctx: Context<InitializeVessel>,
        custody_program: Pubkey,
        deposit_authority: Pubkey,
        withdraw_authority: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            VesselError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.container_mint.to_account_info().owner,
            token_2022::ID,
            VesselError::NotToken2022
        );
        // Pubkeys must be real addresses, never the default (all-zero) pubkey.
        require!(
            custody_program != Pubkey::default(),
            VesselError::InvalidPubkey
        );
        require!(
            deposit_authority != Pubkey::default(),
            VesselError::InvalidPubkey
        );
        require!(
            withdraw_authority != Pubkey::default(),
            VesselError::InvalidPubkey
        );
        // v1 custody is the vessel PDA + Token-2022 token accounts, so the
        // disclosed custody program must be the Token-2022 program ID.
        require_keys_eq!(
            custody_program,
            token_2022::ID,
            VesselError::InvalidCustodyProgram
        );

        let vessel = &mut ctx.accounts.vessel;
        vessel.container_mint = ctx.accounts.container_mint.key();
        vessel.current_owner = ctx.accounts.authority.key();
        vessel.custody_program = custody_program;
        vessel.deposit_authority = deposit_authority;
        vessel.withdraw_authority = withdraw_authority;
        vessel.asset_count = 0;
        vessel.bump = *ctx.bumps.get("vessel").ok_or(VesselError::MathOverflow)?;

        emit!(VesselInitialized {
            container_mint: vessel.container_mint,
            current_owner: vessel.current_owner,
            custody_program: vessel.custody_program,
        });
        Ok(())
    }

    /// Deposit `amount` of `asset_mint` into the vessel's custody account.
    ///
    /// Only `deposit_authority` may call. The custody PDA token account and
    /// the [`VesselHolding`] record are created on first deposit for the
    /// asset (bumping `asset_count`); afterwards the holding amount is
    /// increased and the holding invariant is asserted.
    pub fn deposit_asset(ctx: Context<DepositAsset>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            VesselError::NotToken2022
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.vessel.custody_program,
            VesselError::InvalidCustodyProgram
        );
        require!(amount > 0, VesselError::ZeroAmount);
        require_keys_eq!(
            *ctx.accounts.asset_mint.to_account_info().owner,
            token_2022::ID,
            VesselError::NotToken2022
        );
        // The depositor's account must be a Token-2022 account for this
        // asset mint, owned by the deposit authority (same checks as the
        // curve's sell).
        require_keys_eq!(
            ctx.accounts.depositor_asset_account.mint,
            ctx.accounts.asset_mint.key(),
            VesselError::InvalidDepositorTokenAccount
        );
        require_keys_eq!(
            ctx.accounts.depositor_asset_account.owner,
            ctx.accounts.deposit_authority.key(),
            VesselError::InvalidDepositorTokenAccount
        );
        require_keys_eq!(
            *ctx
                .accounts
                .depositor_asset_account
                .to_account_info()
                .owner,
            token_2022::ID,
            VesselError::NotToken2022
        );
        require!(
            ctx.accounts.depositor_asset_account.amount >= amount,
            VesselError::InsufficientTokenBalance
        );
        // Custody account sanity (seeds + token constraints already bind it
        // to this vessel and asset mint).
        require_keys_eq!(
            ctx.accounts.custody_account.mint,
            ctx.accounts.asset_mint.key(),
            VesselError::InvalidCustodyAccount
        );
        require_keys_eq!(
            ctx.accounts.custody_account.owner,
            ctx.accounts.vessel.key(),
            VesselError::InvalidCustodyAccount
        );

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.depositor_asset_account.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.custody_account.to_account_info(),
                    authority: ctx.accounts.deposit_authority.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.asset_mint.decimals,
        )?;

        // First creation is detectable because init_if_needed zero-fills the
        // account: a live holding record always has asset_mint set.
        if ctx.accounts.holding.asset_mint == Pubkey::default() {
            let vessel_key = ctx.accounts.vessel.key();
            let asset_mint_key = ctx.accounts.asset_mint.key();
            let holding_bump = *ctx
                .bumps
                .get("holding")
                .ok_or(VesselError::MathOverflow)?;
            let holding = &mut ctx.accounts.holding;
            holding.vessel = vessel_key;
            holding.asset_mint = asset_mint_key;
            holding.amount = 0;
            holding.bump = holding_bump;
            let vessel = &mut ctx.accounts.vessel;
            vessel.asset_count = vessel
                .asset_count
                .checked_add(1)
                .ok_or(VesselError::MathOverflow)?;
        }
        {
            let holding = &mut ctx.accounts.holding;
            holding.amount = holding
                .amount
                .checked_add(amount)
                .ok_or(VesselError::MathOverflow)?;
        }

        // Holding invariant: the recorded ledger must exactly equal the
        // custody token account balance after the transfer.
        ctx.accounts.custody_account.reload()?;
        require!(
            ctx.accounts.holding.amount == ctx.accounts.custody_account.amount,
            VesselError::HoldingMismatch
        );

        emit!(AssetDeposited {
            container_mint: ctx.accounts.vessel.container_mint,
            asset_mint: ctx.accounts.asset_mint.key(),
            amount,
        });
        Ok(())
    }

    /// Withdraw `amount` of `asset_mint` from the vessel to `destination`.
    ///
    /// Only `withdraw_authority` may call. The custody PDA signs via the
    /// vessel PDA seeds. The holding record is kept even when its balance
    /// reaches zero (see module docs).
    pub fn withdraw_asset(ctx: Context<WithdrawAsset>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            VesselError::NotToken2022
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.vessel.custody_program,
            VesselError::InvalidCustodyProgram
        );
        require!(amount > 0, VesselError::ZeroAmount);
        require_keys_eq!(
            *ctx.accounts.asset_mint.to_account_info().owner,
            token_2022::ID,
            VesselError::NotToken2022
        );
        // The holding record must belong to this (vessel, asset_mint).
        require_keys_eq!(
            ctx.accounts.holding.asset_mint,
            ctx.accounts.asset_mint.key(),
            VesselError::AssetNotHeld
        );
        require!(
            ctx.accounts.holding.amount >= amount,
            VesselError::InsufficientHoldings
        );
        // Custody account sanity (seeds + token constraints already bind it
        // to this vessel and asset mint).
        require_keys_eq!(
            ctx.accounts.custody_account.mint,
            ctx.accounts.asset_mint.key(),
            VesselError::InvalidCustodyAccount
        );
        require_keys_eq!(
            ctx.accounts.custody_account.owner,
            ctx.accounts.vessel.key(),
            VesselError::InvalidCustodyAccount
        );
        // The destination must be a Token-2022 account for the asset mint;
        // its owner may be anyone.
        require_keys_eq!(
            ctx.accounts.destination.mint,
            ctx.accounts.asset_mint.key(),
            VesselError::InvalidDestinationTokenAccount
        );
        require_keys_eq!(
            *ctx.accounts.destination.to_account_info().owner,
            token_2022::ID,
            VesselError::NotToken2022
        );

        // Move tokens out of custody, signed by the vessel PDA (the custody
        // account's authority).
        let container_mint_key = ctx.accounts.container_mint.key();
        let vessel_bump = ctx.accounts.vessel.bump;
        let signer_seeds: &[&[u8]] =
            &[b"vessel", container_mint_key.as_ref(), &[vessel_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.custody_account.to_account_info(),
                    mint: ctx.accounts.asset_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vessel.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
            ctx.accounts.asset_mint.decimals,
        )?;

        {
            let holding = &mut ctx.accounts.holding;
            holding.amount = holding
                .amount
                .checked_sub(amount)
                .ok_or(VesselError::MathOverflow)?;
        }
        // NOTE: the holding record is intentionally kept at zero rather than
        // closed, preserving the (vessel, asset) history and keeping
        // asset_count stable. Its rent stays with the vessel's records.

        // Holding invariant: the recorded ledger must exactly equal the
        // custody token account balance after the transfer.
        ctx.accounts.custody_account.reload()?;
        require!(
            ctx.accounts.holding.amount == ctx.accounts.custody_account.amount,
            VesselError::HoldingMismatch
        );

        emit!(AssetWithdrawn {
            container_mint: ctx.accounts.vessel.container_mint,
            asset_mint: ctx.accounts.asset_mint.key(),
            amount,
            destination: ctx.accounts.destination.key(),
        });
        Ok(())
    }

    /// Transfer container ownership to `new_owner`.
    ///
    /// All [`VesselHolding`] records move with the container (they are keyed
    /// by the vessel PDA, which does not change); the underlying assets never
    /// move. The deposit/withdraw authorities are independent roles and are
    /// NOT rotated by this instruction.
    pub fn transfer_container(
        ctx: Context<TransferContainer>,
        new_owner: Pubkey,
    ) -> Result<()> {
        require!(
            new_owner != Pubkey::default(),
            VesselError::InvalidPubkey
        );
        let old_owner = ctx.accounts.vessel.current_owner;
        ctx.accounts.vessel.current_owner = new_owner;
        emit!(ContainerTransferred {
            container_mint: ctx.accounts.vessel.container_mint,
            old_owner,
            new_owner,
        });
        Ok(())
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
    #[account(mut)]
    pub deposit_authority: Signer<'info>,
    #[account(
        mut,
        has_one = deposit_authority @ VesselError::Unauthorized,
        seeds = [b"vessel", container_mint.key().as_ref()],
        bump = vessel.bump,
    )]
    pub vessel: Account<'info, VesselConfig>,
    /// Must be the container mint the vessel was initialized with.
    #[account(
        constraint = container_mint.key() == vessel.container_mint
            @ VesselError::ContainerMintMismatch
    )]
    pub container_mint: InterfaceAccount<'info, Mint>,
    /// The asset mint being deposited.
    pub asset_mint: InterfaceAccount<'info, Mint>,
    /// The depositor's Token-2022 token account. Mint, owner, and program
    /// are verified in the instruction body.
    #[account(mut)]
    pub depositor_asset_account: InterfaceAccount<'info, TokenAccount>,
    /// Holding record PDA for (vessel, asset_mint), created on first deposit.
    /// Converted from UncheckedAccount: the seeds bind it to this vessel and
    /// asset mint, and the body detects first creation via the zeroed
    /// asset_mint field to bump asset_count exactly once.
    #[account(
        init_if_needed,
        payer = deposit_authority,
        space = VesselHolding::SPACE,
        seeds = [b"holding", vessel.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub holding: Account<'info, VesselHolding>,
    /// Custody token account PDA owned by the vessel PDA. Converted from
    /// UncheckedAccount: init_if_needed creates a real Token-2022 account
    /// with the vessel PDA as authority, so the program itself — not an
    /// external custodian — holds the assets in v1.
    #[account(
        init_if_needed,
        payer = deposit_authority,
        seeds = [b"custody", vessel.key().as_ref(), asset_mint.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vessel,
        token::token_program = token_program,
    )]
    pub custody_account: InterfaceAccount<'info, TokenAccount>,
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
    /// Must be the container mint the vessel was initialized with.
    #[account(
        constraint = container_mint.key() == vessel.container_mint
            @ VesselError::ContainerMintMismatch
    )]
    pub container_mint: InterfaceAccount<'info, Mint>,
    /// The asset mint being withdrawn.
    pub asset_mint: InterfaceAccount<'info, Mint>,
    /// Holding record PDA for (vessel, asset_mint). Must already exist;
    /// Anchor rejects an uninitialized account before the body runs.
    #[account(
        mut,
        seeds = [b"holding", vessel.key().as_ref(), asset_mint.key().as_ref()],
        bump = holding.bump,
    )]
    pub holding: Account<'info, VesselHolding>,
    /// Custody token account PDA owned by the vessel PDA. Converted from
    /// UncheckedAccount: seeds plus token constraints bind it to this vessel
    /// and asset mint with the vessel PDA as authority.
    #[account(
        mut,
        seeds = [b"custody", vessel.key().as_ref(), asset_mint.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vessel,
        token::token_program = token_program,
    )]
    pub custody_account: InterfaceAccount<'info, TokenAccount>,
    /// Destination Token-2022 token account for the asset mint. Mint and
    /// program are verified in the body; the owner may be any account.
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
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
    /// Pinned to the Token-2022 program ID in v1.
    pub custody_program: Pubkey,
    /// Only this key may deposit assets.
    pub deposit_authority: Pubkey,
    /// Only this key may withdraw assets.
    pub withdraw_authority: Pubkey,
    /// Number of distinct asset mints ever registered in this vessel.
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
// Events (emitted on every state change)
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
    #[msg("This program only operates with the Token-2022 program.")]
    NotToken2022,
    #[msg("Pubkey must not be the default (all-zero) address.")]
    InvalidPubkey,
    #[msg("Depositor token account is not a Token-2022 account for this asset mint owned by the deposit authority.")]
    InvalidDepositorTokenAccount,
    #[msg("Custody account is not a Token-2022 account for this asset mint owned by the vessel PDA.")]
    InvalidCustodyAccount,
    #[msg("Destination is not a Token-2022 token account for this asset mint.")]
    InvalidDestinationTokenAccount,
    #[msg("Token account balance is insufficient for this transfer.")]
    InsufficientTokenBalance,
    #[msg("Container mint does not match the vessel configuration.")]
    ContainerMintMismatch,
    #[msg("VesselHolding amount does not match the custody token account balance; ledger invariant violated.")]
    HoldingMismatch,
}
