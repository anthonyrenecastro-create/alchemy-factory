//! # alchemy_curve — bonding-curve native mechanic (Stage 1)
//!
//! A creator picks one of two audited curve templates — **Linear** or **Step**
//! — and the program mints/burns a Token-2022 token against native-SOL quotes.
//! Arbitrary user-supplied executable formulas are rejected: only the two
//! templates in [`CurveKind`] can be initialized.
//!
//! ## Money flow
//!
//! - **Buy**: trader pays `cost + fee` in lamports. `cost` goes to the reserve
//!   vault PDA; `fee` goes to the treasury account. Tokens are minted to the
//!   trader (the curve-config PDA is the mint authority).
//! - **Sell**: trader burns tokens. The vault PDA pays `proceeds - fee` to the
//!   trader and `fee` to the treasury.
//!
//! ## Rounding rule (reserve-favoring)
//!
//! Buys round **against the trader** (cost and fee rounded UP); sells round
//! **for the reserve** (proceeds rounded DOWN, fee rounded UP). See `math.rs`.
//!
//! ## Slippage protection (two layers)
//!
//! 1. **Trader limit** (`max_cost_lamports` on buy, `min_proceeds_lamports` on
//!    sell): the classic quote-vs-execution guard. Checked first, so a stale
//!    off-chain quote fails with [`CurveError::SlippageExceeded`] even if the
//!    trade would also breach the impact rail.
//! 2. **Price-impact rail** (`max_slippage_bps`, set at init, authority can
//!    update): caps the trade's own price impact versus the pre-trade spot
//!    price. Breach fails with [`CurveError::PriceImpactExceeded`].
//!
//! ## Reserve invariant
//!
//! Every trade asserts that the vault PDA's lamport balance changed by exactly
//! the gross quote (`reserve_delta == quote`). The on-chain `reserve_lamports`
//! bookkeeping mirrors it for the holder app.
//!
//! Because every buy pays at least the integral of the (non-decreasing) price
//! curve and every sell pays out at most that integral, the reserve always
//! covers a full redemption of the outstanding supply. `withdraw_reserve`
//! enforces this: the authority may only withdraw the excess above
//! `sell_proceeds(total_supply, total_supply)`.
//!
//! ## Authorities (all explicit)
//!
//! - `authority`: admin — may update params/fees/treasury, rotate authority,
//!   and withdraw excess reserve (subject to the solvency check above).
//! - Mint authority of the Token-2022 mint: the curve-config PDA (required so
//!   the program can mint on buys).
//! - Freeze authority: **none**. Transfer hooks: **none**. Permanent
//!   delegate: **none**. No Token-2022 extensions are enabled on the mint.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program as solana_program, system_instruction};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

mod math;
use math::{buy_cost, ceil_div, fee_for, impact_bps, sell_proceeds, spot_price, validate_curve};

declare_id!("6fFjhEQx73RZ5sYJLtsyWo53ZDgvfV4YokLdrLh2DPDL");

/// Fixed-point scale for the linear curve: `price(s) = intercept + slope * s / PRICE_SCALE`.
pub const PRICE_SCALE: u128 = 1_000_000_000;
/// Maximum number of steps in a step curve (bounds account size).
pub const MAX_STEPS: usize = 32;
/// Basis-point denominator.
pub const BPS_DENOMINATOR: u128 = 10_000;

#[program]
pub mod alchemy_curve {
    use super::*;

    /// Create a Token-2022 mint and its bonding curve.
    ///
    /// Only [`CurveKind::Linear`] and [`CurveKind::Step`] are accepted; the
    /// enum has no other variants, so arbitrary formulas cannot be smuggled in.
    /// No transfer hooks, permanent delegates, or any other extensions are
    /// enabled on the mint. Freeze authority is left unset (none).
    pub fn initialize_curve(
        ctx: Context<InitializeCurve>,
        decimals: u8,
        curve: CurveKind,
        fee_bps: u16,
        max_slippage_bps: u16,
    ) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            CurveError::NotToken2022
        );
        validate_curve(&curve)?;
        require!(fee_bps <= 10_000, CurveError::InvalidFeeBps);

        // Create the reserve vault: a system-owned PDA that only holds lamports.
        let vault_bump = ctx.bumps.vault;
        let rent_lamports = ctx.accounts.rent.minimum_balance(0);
        let create_ix = system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.vault.key(),
            rent_lamports,
            0,
            &ctx.accounts.system_program.key(),
        );
        solana_program::invoke_signed(
            &create_ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"vault",
                ctx.accounts.mint.key().as_ref(),
                &[vault_bump],
            ]],
        )?;

        let config = &mut ctx.accounts.curve_config;
        config.mint = ctx.accounts.mint.key();
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        let kind_tag = match &curve {
            CurveKind::Linear { .. } => 0u8,
            CurveKind::Step { .. } => 1u8,
        };
        config.curve = curve;
        config.fee_bps = fee_bps;
        config.max_slippage_bps = max_slippage_bps;
        config.reserve_lamports = 0;
        config.total_fees_collected = 0;
        config.bump = ctx.bumps.curve_config;
        config.vault_bump = vault_bump;

        emit!(CurveInitialized {
            mint: config.mint,
            authority: config.authority,
            treasury: config.treasury,
            curve_kind_tag: kind_tag,
            fee_bps,
            max_slippage_bps,
            decimals,
        });
        Ok(())
    }

    /// Buy `amount` base units of the token for at most `max_cost_lamports`.
    pub fn buy(ctx: Context<Buy>, amount: u64, max_cost_lamports: u64) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            CurveError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            CurveError::NotToken2022
        );
        require!(amount > 0, CurveError::ZeroAmount);

        let amount_u128 = amount as u128;
        let supply: u128 = ctx.accounts.mint.supply as u128;
        let cost = buy_cost(&ctx.accounts.curve_config.curve, supply, amount_u128)?;
        let fee = fee_for(cost, ctx.accounts.curve_config.fee_bps)?;
        let total = cost
            .checked_add(fee)
            .ok_or(CurveError::MathOverflow)?;
        // Trader limit first: a stale quote fails here with SlippageExceeded.
        require!(
            total <= max_cost_lamports as u128,
            CurveError::SlippageExceeded
        );
        // Curve-level price-impact rail.
        let spot = spot_price(&ctx.accounts.curve_config.curve, supply)?;
        let avg = ceil_div(cost, amount_u128)?;
        if let Some(impact) = impact_bps(avg, spot)? {
            require!(
                impact <= ctx.accounts.curve_config.max_slippage_bps as u128,
                CurveError::PriceImpactExceeded
            );
        }

        let cost_u64 = u64::try_from(cost).map_err(|_| CurveError::MathOverflow)?;
        let fee_u64 = u64::try_from(fee).map_err(|_| CurveError::MathOverflow)?;

        // Move lamports: buyer -> vault (cost), buyer -> treasury (fee).
        let vault_before = ctx.accounts.vault.lamports();
        transfer_lamports(
            &ctx.accounts.buyer,
            &ctx.accounts.vault,
            &ctx.accounts.system_program,
            cost_u64,
            None,
        )?;
        if fee_u64 > 0 {
            transfer_lamports(
                &ctx.accounts.buyer,
                &ctx.accounts.treasury,
                &ctx.accounts.system_program,
                fee_u64,
                None,
            )?;
        }

        // Mint tokens; the curve-config PDA is the mint authority.
        let mint_key = ctx.accounts.mint.key();
        let config_bump = ctx.accounts.curve_config.bump;
        let signer_seeds: &[&[u8]] = &[b"curve", mint_key.as_ref(), &[config_bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_token_account.to_account_info(),
                    authority: ctx.accounts.curve_config.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        // Reserve invariant: vault delta must equal the gross quote exactly.
        let vault_after = ctx.accounts.vault.to_account_info().lamports();
        require!(
            vault_after
                .checked_sub(vault_before)
                .ok_or(CurveError::ReserveInvariantViolation)?
                == cost_u64,
            CurveError::ReserveInvariantViolation
        );

        let config = &mut ctx.accounts.curve_config;
        config.reserve_lamports = config
            .reserve_lamports
            .checked_add(cost_u64)
            .ok_or(CurveError::MathOverflow)?;
        config.total_fees_collected = config
            .total_fees_collected
            .checked_add(fee_u64)
            .ok_or(CurveError::MathOverflow)?;

        emit!(TradeExecuted {
            mint: mint_key,
            trader: ctx.accounts.buyer.key(),
            is_buy: true,
            amount,
            quote_lamports: cost_u64,
            fee_lamports: fee_u64,
            supply_before: supply as u64,
            supply_after: (supply + amount_u128) as u64,
            reserve_lamports_after: config.reserve_lamports,
        });
        Ok(())
    }

    /// Sell `amount` base units for at least `min_proceeds_lamports`.
    pub fn sell(ctx: Context<Sell>, amount: u64, min_proceeds_lamports: u64) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            CurveError::NotToken2022
        );
        require_keys_eq!(
            *ctx.accounts.mint.to_account_info().owner,
            token_2022::ID,
            CurveError::NotToken2022
        );
        require!(amount > 0, CurveError::ZeroAmount);
        // The seller's token account must be a Token-2022 account for this
        // mint, owned by the seller.
        require_keys_eq!(
            ctx.accounts.seller_token_account.mint,
            ctx.accounts.mint.key(),
            CurveError::InvalidSellerTokenAccount
        );
        require_keys_eq!(
            ctx.accounts.seller_token_account.owner,
            ctx.accounts.seller.key(),
            CurveError::InvalidSellerTokenAccount
        );
        require_keys_eq!(
            *ctx
                .accounts
                .seller_token_account
                .to_account_info()
                .owner,
            token_2022::ID,
            CurveError::NotToken2022
        );
        require!(
            ctx.accounts.seller_token_account.amount >= amount,
            CurveError::InsufficientTokenBalance
        );

        let amount_u128 = amount as u128;
        let supply: u128 = ctx.accounts.mint.supply as u128;
        let proceeds = sell_proceeds(&ctx.accounts.curve_config.curve, supply, amount_u128)?;
        // A sell that quotes zero proceeds must fail closed: without this, a
        // trader could burn tokens and receive nothing (the price-impact rail
        // is also skipped when the floored average price is zero, so no other
        // guard catches it). Mirrors the vault's gross > 0 dust rejection.
        require!(proceeds > 0, CurveError::ZeroAmount);
        let fee = fee_for(proceeds, ctx.accounts.curve_config.fee_bps)?;
        let user_gets = proceeds
            .checked_sub(fee)
            .ok_or(CurveError::MathOverflow)?;
        // Trader limit first: a stale quote fails here with SlippageExceeded.
        require!(
            user_gets >= min_proceeds_lamports as u128,
            CurveError::SlippageExceeded
        );
        // Curve-level price-impact rail.
        let spot = spot_price(&ctx.accounts.curve_config.curve, supply)?;
        let avg = proceeds / amount_u128; // floor: for the reserve
        if let Some(impact) = impact_bps(spot, avg)? {
            require!(
                impact <= ctx.accounts.curve_config.max_slippage_bps as u128,
                CurveError::PriceImpactExceeded
            );
        }

        let proceeds_u64 =
            u64::try_from(proceeds).map_err(|_| CurveError::MathOverflow)?;
        let fee_u64 = u64::try_from(fee).map_err(|_| CurveError::MathOverflow)?;
        let user_gets_u64 =
            u64::try_from(user_gets).map_err(|_| CurveError::MathOverflow)?;

        require!(
            ctx.accounts.curve_config.reserve_lamports >= proceeds_u64,
            CurveError::InsufficientReserve
        );

        // Burn the seller's tokens first (seller signs as token owner).
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_interface::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.seller_token_account.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            amount,
        )?;

        // Pay out from the vault PDA: trader gets proceeds - fee, treasury gets fee.
        let mint_key = ctx.accounts.mint.key();
        let vault_bump = ctx.accounts.curve_config.vault_bump;
        let signer_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[vault_bump]];
        let vault_before = ctx.accounts.vault.lamports();
        transfer_lamports(
            &ctx.accounts.vault,
            &ctx.accounts.seller,
            &ctx.accounts.system_program,
            user_gets_u64,
            Some(signer_seeds),
        )?;
        if fee_u64 > 0 {
            transfer_lamports(
                &ctx.accounts.vault,
                &ctx.accounts.treasury,
                &ctx.accounts.system_program,
                fee_u64,
                Some(signer_seeds),
            )?;
        }

        // Reserve invariant: vault delta must equal the gross quote exactly.
        let vault_after = ctx.accounts.vault.to_account_info().lamports();
        require!(
            vault_before
                .checked_sub(vault_after)
                .ok_or(CurveError::ReserveInvariantViolation)?
                == proceeds_u64,
            CurveError::ReserveInvariantViolation
        );

        let config = &mut ctx.accounts.curve_config;
        config.reserve_lamports = config
            .reserve_lamports
            .checked_sub(proceeds_u64)
            .ok_or(CurveError::MathOverflow)?;
        config.total_fees_collected = config
            .total_fees_collected
            .checked_add(fee_u64)
            .ok_or(CurveError::MathOverflow)?;

        emit!(TradeExecuted {
            mint: mint_key,
            trader: ctx.accounts.seller.key(),
            is_buy: false,
            amount,
            quote_lamports: proceeds_u64,
            fee_lamports: fee_u64,
            supply_before: supply as u64,
            supply_after: (supply - amount_u128) as u64,
            reserve_lamports_after: config.reserve_lamports,
        });
        Ok(())
    }

    /// Update fee / slippage / treasury. Authority only.
    pub fn update_params(
        ctx: Context<CurveAdmin>,
        fee_bps: Option<u16>,
        max_slippage_bps: Option<u16>,
        treasury: Option<Pubkey>,
    ) -> Result<()> {
        if let Some(f) = fee_bps {
            require!(f <= 10_000, CurveError::InvalidFeeBps);
            ctx.accounts.curve_config.fee_bps = f;
        }
        if let Some(s) = max_slippage_bps {
            ctx.accounts.curve_config.max_slippage_bps = s;
        }
        if let Some(t) = treasury {
            ctx.accounts.curve_config.treasury = t;
        }
        emit!(CurveParamsUpdated {
            mint: ctx.accounts.curve_config.mint,
            fee_bps: ctx.accounts.curve_config.fee_bps,
            max_slippage_bps: ctx.accounts.curve_config.max_slippage_bps,
            treasury: ctx.accounts.curve_config.treasury,
        });
        Ok(())
    }

    /// Rotate the admin authority. Authority only. Emits the change.
    ///
    /// The all-zero address is rejected: rotating to it would permanently
    /// lock out every admin instruction (params, treasury, withdrawals).
    pub fn update_authority(
        ctx: Context<CurveAdmin>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            CurveError::InvalidPubkey
        );
        let old = ctx.accounts.curve_config.authority;
        ctx.accounts.curve_config.authority = new_authority;
        emit!(CurveAuthorityUpdated {
            mint: ctx.accounts.curve_config.mint,
            old_authority: old,
            new_authority,
        });
        Ok(())
    }

    /// Withdraw `amount` lamports of *excess* reserve to `destination`.
    ///
    /// Authority only. The withdrawal is rejected unless the reserve that
    /// remains covers a full redemption of the outstanding supply at current
    /// quotes ([`CurveError::InsolvencyViolation`]). This is the solvency
    /// guard: collected rounding dust and value drift can be swept, but the
    /// backing for every circulating token cannot.
    pub fn withdraw_reserve(
        ctx: Context<WithdrawReserve>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, CurveError::ZeroAmount);
        let supply: u128 = ctx.accounts.mint.supply as u128;
        // Full-redemption cover: what the vault would pay if every token were
        // sold right now. The reserve provably stays >= this value across
        // trades (buys round up, sells round down, curve is non-decreasing).
        let cover = sell_proceeds(&ctx.accounts.curve_config.curve, supply, supply)?;
        let reserve = ctx.accounts.curve_config.reserve_lamports as u128;
        require!(
            reserve >= amount as u128,
            CurveError::InsufficientReserve
        );
        let reserve_after = reserve - amount as u128;
        require!(reserve_after >= cover, CurveError::InsolvencyViolation);

        let mint_key = ctx.accounts.mint.key();
        let vault_bump = ctx.accounts.curve_config.vault_bump;
        let signer_seeds: &[&[u8]] = &[b"vault", mint_key.as_ref(), &[vault_bump]];
        let vault_before = ctx.accounts.vault.lamports();
        transfer_lamports(
            &ctx.accounts.vault,
            &ctx.accounts.destination,
            &ctx.accounts.system_program,
            amount,
            Some(signer_seeds),
        )?;
        let vault_after = ctx.accounts.vault.to_account_info().lamports();
        require!(
            vault_before
                .checked_sub(vault_after)
                .ok_or(CurveError::ReserveInvariantViolation)?
                == amount,
            CurveError::ReserveInvariantViolation
        );

        ctx.accounts.curve_config.reserve_lamports = reserve_after as u64;
        emit!(ReserveWithdrawn {
            mint: mint_key,
            destination: ctx.accounts.destination.key(),
            amount,
            reserve_lamports_after: reserve_after as u64,
        });
        Ok(())
    }
}

/// Native-SOL transfer, optionally signed by a PDA.
fn transfer_lamports<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    lamports: u64,
    signer_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let ix = system_instruction::transfer(&from.key(), &to.key(), lamports);
    let infos = &[from.clone(), to.clone(), system_program.clone()];
    match signer_seeds {
        Some(seeds) => solana_program::invoke_signed(&ix, infos, &[seeds])?,
        None => solana_program::invoke(&ix, infos)?,
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(decimals: u8)]
pub struct InitializeCurve<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = CurveConfig::SPACE,
        seeds = [b"curve", mint.key().as_ref()],
        bump,
    )]
    pub curve_config: Account<'info, CurveConfig>,
    #[account(
        init,
        payer = authority,
        mint::decimals = decimals,
        mint::authority = curve_config,
        mint::token_program = token_program,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Reserve vault PDA. Created by this instruction via the system
    /// program; it holds only lamports and has no data.
    #[account(mut, seeds = [b"vault", mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Fee recipient. Any account; it only ever receives lamports.
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"curve", mint.key().as_ref()],
        bump = curve_config.bump,
    )]
    pub curve_config: Account<'info, CurveConfig>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Reserve vault PDA; its lamport delta is asserted against the quote.
    #[account(
        mut,
        seeds = [b"vault", mint.key().as_ref()],
        bump = curve_config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Must equal the treasury recorded in the curve config, so fees
    /// cannot be diverted to an arbitrary account.
    #[account(
        mut,
        constraint = treasury.key() == curve_config.treasury @ CurveError::TreasuryMismatch
    )]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        seeds = [b"curve", mint.key().as_ref()],
        bump = curve_config.bump,
    )]
    pub curve_config: Account<'info, CurveConfig>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Reserve vault PDA; its lamport delta is asserted against the quote.
    #[account(
        mut,
        seeds = [b"vault", mint.key().as_ref()],
        bump = curve_config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    /// The seller's Token-2022 token account. Ownership, mint, and program
    /// are verified in the instruction body.
    #[account(mut)]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Must equal the treasury recorded in the curve config.
    #[account(
        mut,
        constraint = treasury.key() == curve_config.treasury @ CurveError::TreasuryMismatch
    )]
    pub treasury: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Shared admin context: every instruction here requires the current authority.
#[derive(Accounts)]
pub struct CurveAdmin<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ CurveError::Unauthorized,
        seeds = [b"curve", mint.key().as_ref()],
        bump = curve_config.bump,
    )]
    pub curve_config: Account<'info, CurveConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct WithdrawReserve<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ CurveError::Unauthorized,
        seeds = [b"curve", mint.key().as_ref()],
        bump = curve_config.bump,
    )]
    pub curve_config: Account<'info, CurveConfig>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Reserve vault PDA.
    #[account(
        mut,
        seeds = [b"vault", mint.key().as_ref()],
        bump = curve_config.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Destination for the withdrawn excess reserve. Any account.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// A single step of a step curve: `price` lamports per base unit applies from
/// `supply` (inclusive) until the next threshold.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct StepPoint {
    pub supply: u128,
    pub price: u128,
}

/// The only curve templates this program supports. There is deliberately no
/// "custom formula" variant: v1 does not accept arbitrary executable pricing.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum CurveKind {
    /// `price(s) = intercept + slope * s / PRICE_SCALE` lamports per base unit.
    Linear { slope: u128, intercept: u128 },
    /// Piecewise-constant price; validated non-decreasing at init.
    Step { thresholds: Vec<StepPoint> },
}

#[account]
pub struct CurveConfig {
    /// The Token-2022 mint this curve prices.
    pub mint: Pubkey,
    /// Admin authority: params, treasury, authority rotation, excess-reserve
    /// withdrawal (solvency-checked).
    pub authority: Pubkey,
    /// Fee recipient (receives lamports only).
    pub treasury: Pubkey,
    /// The active pricing template.
    pub curve: CurveKind,
    /// Fee in basis points on every trade (<= 10_000).
    pub fee_bps: u16,
    /// Max allowed price impact of a single trade vs pre-trade spot, in bps.
    pub max_slippage_bps: u16,
    /// Gross lamports currently held in the vault for redemptions (excludes
    /// the vault's rent-exempt minimum; fees go to the treasury, not here).
    pub reserve_lamports: u64,
    /// Lifetime fees routed to the treasury.
    pub total_fees_collected: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl CurveConfig {
    /// 8 (disc) + 32 mint + 32 authority + 32 treasury
    ///   + 1 (enum tag) + 4 (vec len) + 32 * (16 + 16) (max steps)
    ///   + 2 fee_bps + 2 max_slippage_bps + 8 reserve + 8 fees + 1 + 1 bumps.
    pub const SPACE: usize = 8 + 32 + 32 + 32 + (1 + 4 + MAX_STEPS * 32) + 2 + 2 + 8 + 8 + 1 + 1;
}

// ---------------------------------------------------------------------------
// Events (emitted on every state change)
// ---------------------------------------------------------------------------

#[event]
pub struct CurveInitialized {
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    /// 0 = Linear, 1 = Step.
    pub curve_kind_tag: u8,
    pub fee_bps: u16,
    pub max_slippage_bps: u16,
    pub decimals: u8,
}

#[event]
pub struct TradeExecuted {
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub amount: u64,
    /// Gross quote in lamports (cost on buy, proceeds on sell), before fees.
    pub quote_lamports: u64,
    pub fee_lamports: u64,
    pub supply_before: u64,
    pub supply_after: u64,
    pub reserve_lamports_after: u64,
}

#[event]
pub struct CurveParamsUpdated {
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub max_slippage_bps: u16,
    pub treasury: Pubkey,
}

#[event]
pub struct CurveAuthorityUpdated {
    pub mint: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct ReserveWithdrawn {
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub reserve_lamports_after: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum CurveError {
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
    #[msg("Caller is not the curve authority.")]
    Unauthorized,
    #[msg("Execution price moved beyond the trader's limit (slippage).")]
    SlippageExceeded,
    #[msg("Trade price impact exceeds the curve's max_slippage_bps.")]
    PriceImpactExceeded,
    #[msg("Vault reserve is insufficient for this withdrawal or sale.")]
    InsufficientReserve,
    #[msg("Invalid curve parameters: monotonicity or sanity check failed.")]
    InvalidCurve,
    #[msg("fee_bps must not exceed 10000.")]
    InvalidFeeBps,
    #[msg("Withdrawal would leave the reserve below the full-redemption value of outstanding supply.")]
    InsolvencyViolation,
    #[msg("Vault lamport delta did not equal the trade quote; reserve invariant violated.")]
    ReserveInvariantViolation,
    #[msg("Sell amount exceeds current token supply.")]
    AmountExceedsSupply,
    #[msg("This program only operates with the Token-2022 program.")]
    NotToken2022,
    #[msg("Treasury account does not match the curve configuration.")]
    TreasuryMismatch,
    #[msg("Seller token account is not a Token-2022 account for this mint owned by the seller.")]
    InvalidSellerTokenAccount,
    #[msg("Seller token balance is insufficient for this sale.")]
    InsufficientTokenBalance,
    #[msg("Pubkey must not be the default (all-zero) address.")]
    InvalidPubkey,
}
