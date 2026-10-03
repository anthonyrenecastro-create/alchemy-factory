//! # alchemy_vault — PAXG collateral module (Stage 3)
//!
//! A segregated on-chain vault for an optional collateral asset: an
//! unmistakably labeled **mock** asset (`MOCK-GOLD`) on devnet; the real PAXG
//! mint only on mainnet after the official Paxos Solana mint address is
//! verified (Stage 4).
//!
//! ## Mechanics (ERC-4626-style share vault, integer math)
//!
//! - [`deposit_collateral`]: depositor sends collateral into the vault's
//!   PDA-owned Token-2022 token account and receives newly minted shares.
//!   First deposit is 1:1 in base units; later deposits mint
//!   `floor(amount * total_shares / total_collateral)`. A deposit that would
//!   mint zero shares (dust) is rejected.
//! - [`redeem_shares`]: redeemer burns shares and receives
//!   `gross = floor(shares * total_collateral / total_shares)` minus
//!   `fee = ceil(gross * redeem_fee_bps / 10000)`; the net goes to the
//!   redeemer, the fee to the treasury. Each redemption is capped by the
//!   withdrawal limit `floor(total_collateral * withdrawal_limit_bps / 10000)`.
//! - All intermediate arithmetic is `u128` with checked operations; anything
//!   that does not fit aborts with [`VaultError::MathOverflow`]. The TS SDK
//!   (`sdk/src/vault.ts`) mirrors these formulas exactly.
//!
//! ## Enforced invariants
//!
//! - **Solvency**: after every state-changing instruction the vault's
//!   collateral token-account balance must be `>= total_collateral`
//!   ([`VaultError::Insolvent`] otherwise). Direct transfers into the vault
//!   account (donations) are tolerated — they can only raise the balance.
//! - **Collateral allow-list** (honesty-critical): [`initialize_vault`]
//!   parses the collateral mint's Token-2022 extensions and accepts ONLY
//!   `MetadataPointer`, `TokenMetadata`, and `MintCloseAuthority`. Anything
//!   else — permanent delegate, transfer fees, transfer hooks, default-frozen
//!   state, non-transferable, the confidential-transfer suite, CPI guard,
//!   interest-bearing, scaled UI amounts, pausable, group extensions — is
//!   rejected. This policy explicitly rejects the real PAXG mint in Stage 3
//!   (it carries a permanent delegate); accepting real PAXG is a Stage-4
//!   decision made as an explicit per-mint allow-list entry, never by
//!   widening this rule.
//! - **Mock honesty**: `is_mock_collateral` + `mock_label` are recorded
//!   on-chain declarations. The program CANNOT verify which cluster it runs
//!   on, so "mock is devnet-only" is an operator rule (docs/STAGES.md), not
//!   a program check. A vault declaring real collateral may not carry a mock
//!   label, and vice versa.
//! - The vault's own share mint carries ONLY `MetadataPointer` +
//!   `TokenMetadata` — never transfer hooks or permanent delegates — with
//!   unmistakable labeling (`Alchemy Vault Share (MOCK)` / `AVS-MOCK` for
//!   mock vaults), mint authority = vault PDA, no freeze authority.
//! - [`publish_proof`] emits an independent, read-only [`VaultProof`]
//!   snapshot (balance, outstanding claims, collateral ratio in bps,
//!   authority/treasury configuration) that anyone can recompute.
//!
//! The UI displays a *calculated* collateral value / redemption claim — never
//! a guaranteed market-price floor. Mock collateral is rejected anywhere real
//! PAXG is expected ([`VaultError::MockAssetMisuse`]).
//!
//! Status: implemented; UNVERIFIED (CI gate + devnet end-to-end still
//! pending — see docs/STAGES.md). Not deployed; deployment needs explicit
//! approval.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke, invoke_signed},
    system_instruction,
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::BaseStateWithExtensions;
use anchor_spl::token_2022_extensions::spl_pod::optional_keys::OptionalNonZeroPubkey;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::{
    instruction as token_metadata_ix, state::TokenMetadata,
};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

declare_id!("Fm6Uh2nzTnWXtXhR3B76BndV4s4kiBRA9fEv7BskDgHx");

/// Max bytes for the mock-asset label (e.g. "MOCK-GOLD — NOT PAXG").
pub const MAX_MOCK_LABEL_LEN: usize = 64;

/// Basis-point denominator for the withdrawal limit and the redeem fee.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Share-mint display name for vaults holding declared mock collateral.
pub const SHARE_NAME_MOCK: &str = "Alchemy Vault Share (MOCK)";
/// Share-mint symbol for vaults holding declared mock collateral.
pub const SHARE_SYMBOL_MOCK: &str = "AVS-MOCK";
/// Share-mint display name for vaults holding declared real collateral.
pub const SHARE_NAME_REAL: &str = "Alchemy Vault Share";
/// Share-mint symbol for vaults holding declared real collateral.
pub const SHARE_SYMBOL_REAL: &str = "AVS";

#[program]
pub mod alchemy_vault {
    use super::*;

    /// Create a segregated vault for `collateral_mint`, with a share mint
    /// representing pro-rata claims.
    ///
    /// `is_mock_collateral` must be true on devnet; the label must make the
    /// mock nature unmistakable. The flag is a *recorded declaration* — the
    /// program cannot verify the cluster, so devnet-only usage is an
    /// operator rule (docs/STAGES.md), not a program check.
    ///
    /// The collateral mint must pass the extension allow-list
    /// ([`validate_collateral_mint`]); the real PAXG mint is rejected in
    /// Stage 3 because it carries a permanent delegate.
    ///
    /// Creates two PDAs: the share mint (`[b"vault-shares", vault]`,
    /// Token-2022 with MetadataPointer + TokenMetadata only, mint authority
    /// = vault PDA, no freeze authority, decimals = collateral decimals) and
    /// the vault's collateral token account (`[b"vault-collateral", vault]`,
    /// plain Token-2022, token-authority = vault PDA).
    ///
    /// NOTE on the `collateral_mint` instruction arg: the mint is also passed
    /// as an account (needed for decimals, extension parsing, and PDA
    /// seeds). The arg is kept for explicitness and must agree with the
    /// account; the account's key is what the PDA seeds use. No
    /// `#[instruction]` attribute is needed: the `seeds` expressions only
    /// reference account fields, never instruction args.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        collateral_mint: Pubkey,
        withdrawal_limit_bps: u16,
        redeem_fee_bps: u16,
        is_mock_collateral: bool,
        mock_label: String,
    ) -> Result<()> {
        require_keys_eq!(
            collateral_mint,
            ctx.accounts.collateral_mint.key(),
            VaultError::InvalidCollateralMint
        );
        require!(
            withdrawal_limit_bps <= 10_000,
            VaultError::InvalidBps
        );
        require!(redeem_fee_bps <= 10_000, VaultError::InvalidBps);

        // Mock labeling is a recorded, on-chain declaration. Mock vaults
        // need a non-empty, unmistakable label that fits the account; vaults
        // declaring real collateral must not carry a mock label at all.
        if is_mock_collateral {
            require!(
                !mock_label.is_empty() && mock_label.len() <= MAX_MOCK_LABEL_LEN,
                VaultError::InvalidMockLabel
            );
        } else {
            require!(mock_label.is_empty(), VaultError::InvalidMockLabel);
        }

        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            VaultError::NotToken2022
        );

        // Honesty-critical gate: reject any collateral mint carrying
        // extensions outside the allow-list.
        let collateral_decimals = validate_collateral_mint(&ctx.accounts.collateral_mint)?;

        let vault_key = ctx.accounts.vault_config.key();
        let collateral_mint_key = ctx.accounts.collateral_mint.key();
        let authority_key = ctx.accounts.authority.key();
        let vault_bump = ctx.bumps.vault_config;
        let vault_seeds: &[&[u8]] = &[b"vault", collateral_mint_key.as_ref(), &[vault_bump]];

        // --- Share mint --------------------------------------------------
        // PDA so the (vault -> share mint) binding is deterministic and the
        // mint cannot be swapped for a lookalike later.
        let (share_mint_pda, share_bump) = Pubkey::find_program_address(
            &[b"vault-shares", vault_key.as_ref()],
            ctx.program_id,
        );
        require_keys_eq!(
            share_mint_pda,
            ctx.accounts.share_mint.key(),
            VaultError::InvalidShareMint
        );
        let share_seeds: &[&[u8]] = &[b"vault-shares", vault_key.as_ref(), &[share_bump]];

        // Metadata-only extensions: MetadataPointer + TokenMetadata. Never a
        // transfer hook, permanent delegate, or anything else. The label
        // tracks the mock declaration so a mock share mint can never be
        // mistaken for a real-collateral claim.
        let (share_name, share_symbol) = if is_mock_collateral {
            (SHARE_NAME_MOCK, SHARE_SYMBOL_MOCK)
        } else {
            (SHARE_NAME_REAL, SHARE_SYMBOL_REAL)
        };
        let token_metadata = TokenMetadata {
            update_authority: OptionalNonZeroPubkey::try_from(Some(authority_key))
                .map_err(|_| VaultError::InvalidPubkey)?,
            mint: share_mint_pda,
            name: share_name.to_string(),
            symbol: share_symbol.to_string(),
            uri: String::new(),
            additional_metadata: Vec::new(),
        };
        let metadata_len = token_metadata
            .tlv_size_of()
            .map_err(|_| VaultError::MathOverflow)?;
        // TokenMetadata is variable-length, and try_calculate_account_len
        // FAILS for variable-length extensions — so only the fixed
        // MetadataPointer extension goes in the list, and the metadata's
        // own TLV size (type + length + value, from tlv_size_of above) is
        // added on top.
        let mint_len = spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
            spl_token_2022::state::Mint,
        >(
            &[
                spl_token_2022::extension::ExtensionType::MetadataPointer,
            ],
        )
        .map_err(|_| VaultError::MathOverflow)?;
        let share_space = mint_len
            .checked_add(metadata_len)
            .ok_or(VaultError::MathOverflow)?;

        // Allocate ONLY the MetadataPointer space, but fund rent for the
        // full layout. Pre-allocating the TokenMetadata region leaves zeros
        // after the MetadataPointer TLV entry, and InitializeMint2's TLV
        // parser rejects them (InvalidAccountData — observed in CI run 8,
        // and in the test fixture before it). The token-metadata initialize
        // CPI below reallocates the account from mint_len to share_space
        // itself.
        invoke_signed(
            &system_instruction::create_account(
                &authority_key,
                &share_mint_pda,
                ctx.accounts.rent.minimum_balance(share_space),
                mint_len as u64,
                &token_2022::ID,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.share_mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[share_seeds],
        )?;

        // Extension init order for Token-2022: metadata pointer, then the
        // base mint, then the token-metadata value.
        invoke(
            &spl_token_2022::extension::metadata_pointer::instruction::initialize(
                &token_2022::ID,
                &share_mint_pda,
                Some(authority_key),
                Some(share_mint_pda),
            )
            .map_err(|_| VaultError::MathOverflow)?,
            &[ctx.accounts.share_mint.to_account_info()],
        )?;

        // Mint authority = vault PDA (only this program mints shares);
        // freeze authority = None (shares can never be frozen); decimals
        // mirror the collateral mint so the first deposit is exactly 1:1 in
        // base units.
        invoke(
            &spl_token_2022::instruction::initialize_mint2(
                &token_2022::ID,
                &share_mint_pda,
                &vault_key,
                None,
                collateral_decimals,
            )
            .map_err(|_| VaultError::MathOverflow)?,
            &[ctx.accounts.share_mint.to_account_info()],
        )?;

        // The token-metadata `initialize` instruction requires the mint
        // authority to sign; the vault PDA does so via seeds.
        invoke_signed(
            &token_metadata_ix::initialize(
                &token_2022::ID,
                &share_mint_pda, // metadata lives in the mint account itself
                &authority_key,  // metadata update authority
                &share_mint_pda, // mint
                &vault_key,      // mint authority (signer)
                share_name.to_string(),
                share_symbol.to_string(),
                String::new(),
            ),
            &[
                ctx.accounts.share_mint.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.vault_config.to_account_info(),
            ],
            &[vault_seeds],
        )?;

        // --- Vault collateral token account ------------------------------
        // PDA whose token-authority is the vault PDA. Plain Token-2022
        // account, no extensions.
        let (collateral_pda, collateral_bump) = Pubkey::find_program_address(
            &[b"vault-collateral", vault_key.as_ref()],
            ctx.program_id,
        );
        require_keys_eq!(
            collateral_pda,
            ctx.accounts.vault_collateral_account.key(),
            VaultError::InvalidCollateralMint
        );
        let collateral_seeds: &[&[u8]] =
            &[b"vault-collateral", vault_key.as_ref(), &[collateral_bump]];
        let token_account_len =
            spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
                spl_token_2022::state::Account,
            >(&[])
            .map_err(|_| VaultError::MathOverflow)?;
        invoke_signed(
            &system_instruction::create_account(
                &authority_key,
                &collateral_pda,
                ctx.accounts.rent.minimum_balance(token_account_len),
                token_account_len as u64,
                &token_2022::ID,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.vault_collateral_account.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[collateral_seeds],
        )?;
        invoke(
            &spl_token_2022::instruction::initialize_account3(
                &token_2022::ID,
                &collateral_pda,
                &collateral_mint_key,
                &vault_key,
            )
            .map_err(|_| VaultError::MathOverflow)?,
            &[
                ctx.accounts.vault_collateral_account.to_account_info(),
                ctx.accounts.collateral_mint.to_account_info(),
            ],
        )?;

        // --- Config ------------------------------------------------------
        let config = &mut ctx.accounts.vault_config;
        config.collateral_mint = collateral_mint_key;
        config.share_mint = share_mint_pda;
        config.authority = authority_key;
        // Fee recipient defaults to the initializing authority; the current
        // authority may rotate it later with `update_vault_treasury`.
        // Rotating the vault authority does not move already-accrued fees.
        config.treasury = authority_key;
        config.total_collateral = 0;
        config.total_shares = 0;
        config.withdrawal_limit_bps = withdrawal_limit_bps;
        config.redeem_fee_bps = redeem_fee_bps;
        config.is_mock_collateral = is_mock_collateral;
        config.mock_label = mock_label;
        config.bump = vault_bump;

        emit!(VaultInitialized {
            collateral_mint: collateral_mint_key,
            share_mint: share_mint_pda,
            authority: authority_key,
            withdrawal_limit_bps,
            redeem_fee_bps,
            is_mock_collateral,
        });
        Ok(())
    }

    /// Deposit `amount` of collateral; receive newly minted shares pro-rata.
    ///
    /// First deposit mints 1:1 in base units; later deposits mint
    /// `floor(amount * total_shares / total_collateral)`. A deposit that
    /// would mint zero shares (dust) is rejected. The depositor's share ATA
    /// is created if missing (depositor pays).
    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            VaultError::NotToken2022
        );
        require!(amount > 0, VaultError::ZeroAmount);

        // The depositor's account must be a Token-2022 account for the
        // vault's collateral mint. The transfer CPI below enforces that the
        // depositor owns (or is delegate for) it.
        require_keys_eq!(
            ctx.accounts.depositor_collateral_account.mint,
            ctx.accounts.vault_config.collateral_mint,
            VaultError::InvalidCollateralMint
        );
        require_token_2022_owned(
            &ctx.accounts.depositor_collateral_account.to_account_info(),
        )?;
        // The vault-side accounts are PDA-bound by the constraints above;
        // pin their Token-2022 program ownership explicitly too.
        require_token_2022_owned(&ctx.accounts.share_mint.to_account_info())?;
        require_token_2022_owned(
            &ctx.accounts.vault_collateral_account.to_account_info(),
        )?;

        // Pro-rata share math (u128 intermediates, checked; mirrors
        // sdk/src/vault.ts exactly). Deposits floor in favor of existing
        // holders: any remainder stays in the vault, slightly raising the
        // share price for everyone else.
        let shares = {
            let config = &ctx.accounts.vault_config;
            if config.total_shares == 0 {
                // First deposit defines the share price 1:1 in base units.
                amount
            } else {
                let shares128 = (amount as u128)
                    .checked_mul(config.total_shares as u128)
                    .ok_or(VaultError::MathOverflow)?
                    .checked_div(config.total_collateral as u128)
                    .ok_or(VaultError::MathOverflow)?;
                u64::try_from(shares128).map_err(|_| VaultError::MathOverflow)?
            }
        };
        // Dust deposits that would mint zero shares are rejected outright so
        // collateral is never absorbed without representation.
        require!(shares > 0, VaultError::ZeroAmount);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.depositor_collateral_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.vault_collateral_account.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.collateral_mint.decimals,
        )?;

        // Mint the shares; the vault PDA is the share mint's mint authority.
        let vault_bump = ctx.accounts.vault_config.bump;
        let collateral_mint_key = ctx.accounts.vault_config.collateral_mint;
        let signer_seeds: &[&[u8]] = &[b"vault", collateral_mint_key.as_ref(), &[vault_bump]];
        token_interface::mint_to_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::MintToChecked {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.depositor_share_account.to_account_info(),
                    authority: ctx.accounts.vault_config.to_account_info(),
                },
                &[signer_seeds],
            ),
            shares,
            ctx.accounts.share_mint.decimals,
        )?;

        {
            let config = &mut ctx.accounts.vault_config;
            config.total_collateral = config
                .total_collateral
                .checked_add(amount)
                .ok_or(VaultError::MathOverflow)?;
            config.total_shares = config
                .total_shares
                .checked_add(shares)
                .ok_or(VaultError::MathOverflow)?;
        }

        assert_solvent(
            &ctx.accounts.vault_config,
            &mut ctx.accounts.vault_collateral_account,
        )?;

        emit!(CollateralDeposited {
            collateral_mint: ctx.accounts.vault_config.collateral_mint,
            depositor: ctx.accounts.depositor.key(),
            amount,
            shares_minted: shares,
        });
        Ok(())
    }

    /// Burn `shares`; receive the pro-rata collateral minus the redeem fee,
    /// subject to the withdrawal limit and the solvency invariant.
    ///
    /// `gross = floor(shares * total_collateral / total_shares)` must not
    /// exceed `floor(total_collateral * withdrawal_limit_bps / 10000)`;
    /// `fee = ceil(gross * redeem_fee_bps / 10000)`; the redeemer receives
    /// `net = gross - fee` and the treasury receives `fee`.
    pub fn redeem_shares(ctx: Context<RedeemShares>, shares: u64) -> Result<()> {
        require!(
            ctx.accounts.token_program.key() == token_2022::ID,
            VaultError::NotToken2022
        );
        require!(shares > 0, VaultError::ZeroAmount);
        require_token_2022_owned(&ctx.accounts.redeemer_share_account.to_account_info())?;
        require_token_2022_owned(
            &ctx.accounts.redeemer_collateral_account.to_account_info(),
        )?;
        require_token_2022_owned(&ctx.accounts.treasury.to_account_info())?;
        // The vault-side accounts are PDA-bound by the constraints above;
        // pin their Token-2022 program ownership explicitly too.
        require_token_2022_owned(&ctx.accounts.share_mint.to_account_info())?;
        require_token_2022_owned(
            &ctx.accounts.vault_collateral_account.to_account_info(),
        )?;

        // The burned shares must be this vault's shares; the payout and fee
        // accounts must be Token-2022 accounts for the collateral mint, and
        // the fee account must belong to the recorded treasury recipient.
        require_keys_eq!(
            ctx.accounts.redeemer_share_account.mint,
            ctx.accounts.vault_config.share_mint,
            VaultError::InvalidShareMint
        );
        require_keys_eq!(
            ctx.accounts.redeemer_collateral_account.mint,
            ctx.accounts.vault_config.collateral_mint,
            VaultError::InvalidCollateralMint
        );
        require_keys_eq!(
            ctx.accounts.treasury.mint,
            ctx.accounts.vault_config.collateral_mint,
            VaultError::InvalidTreasuryAccount
        );
        require_keys_eq!(
            ctx.accounts.treasury.owner,
            ctx.accounts.vault_config.treasury,
            VaultError::InvalidTreasuryAccount
        );

        // Redemption math (u128 intermediates, checked; mirrors
        // sdk/src/vault.ts exactly). Gross floors in favor of vault solvency;
        // the fee ceils in favor of the treasury / remaining holders.
        let (gross, fee, net) = {
            let config = &ctx.accounts.vault_config;
            require!(
                shares <= config.total_shares,
                VaultError::InsufficientShares
            );
            // shares > 0 and shares <= total_shares implies total_shares > 0.
            let gross128 = (shares as u128)
                .checked_mul(config.total_collateral as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(config.total_shares as u128)
                .ok_or(VaultError::MathOverflow)?;
            let gross = u64::try_from(gross128).map_err(|_| VaultError::MathOverflow)?;
            require!(gross > 0, VaultError::ZeroAmount);

            // The limit floors, so the cap is never rounded up past the
            // configured bps.
            let limit128 = (config.total_collateral as u128)
                .checked_mul(config.withdrawal_limit_bps as u128)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(BPS_DENOMINATOR)
                .ok_or(VaultError::MathOverflow)?;
            let limit = u64::try_from(limit128).map_err(|_| VaultError::MathOverflow)?;
            require!(gross <= limit, VaultError::WithdrawalLimitExceeded);

            let fee128 = if config.redeem_fee_bps == 0 {
                0
            } else {
                ceil_div(
                    (gross as u128)
                        .checked_mul(config.redeem_fee_bps as u128)
                        .ok_or(VaultError::MathOverflow)?,
                    BPS_DENOMINATOR,
                )?
            };
            let fee = u64::try_from(fee128).map_err(|_| VaultError::MathOverflow)?;
            // fee <= gross because redeem_fee_bps <= 10000 (checked at init).
            let net = gross.checked_sub(fee).ok_or(VaultError::MathOverflow)?;
            (gross, fee, net)
        };

        // Burn the redeemed shares. NOTE: the burn authority is the REDEEMER
        // — the owner of the share token account, who signs this
        // instruction. Token-2022 burn requires the source account's owner
        // (or delegate); the share mint's mint authority (the vault PDA)
        // cannot authorize burns from other owners' accounts.
        token_interface::burn_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token_interface::BurnChecked {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.redeemer_share_account.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            ),
            shares,
            ctx.accounts.share_mint.decimals,
        )?;

        // Pay out the net to the redeemer and the fee to the treasury,
        // signed by the vault PDA (owner of the vault collateral account).
        let vault_bump = ctx.accounts.vault_config.bump;
        let collateral_mint_key = ctx.accounts.vault_config.collateral_mint;
        let signer_seeds: &[&[u8]] = &[b"vault", collateral_mint_key.as_ref(), &[vault_bump]];
        let decimals = ctx.accounts.collateral_mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.vault_collateral_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.redeemer_collateral_account.to_account_info(),
                    authority: ctx.accounts.vault_config.to_account_info(),
                },
                &[signer_seeds],
            ),
            net,
            decimals,
        )?;
        if fee > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token_interface::TransferChecked {
                        from: ctx.accounts.vault_collateral_account.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                        authority: ctx.accounts.vault_config.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                fee,
                decimals,
            )?;
        }

        {
            let config = &mut ctx.accounts.vault_config;
            config.total_collateral = config
                .total_collateral
                .checked_sub(gross)
                .ok_or(VaultError::MathOverflow)?;
            config.total_shares = config
                .total_shares
                .checked_sub(shares)
                .ok_or(VaultError::MathOverflow)?;
        }

        assert_solvent(
            &ctx.accounts.vault_config,
            &mut ctx.accounts.vault_collateral_account,
        )?;

        emit!(SharesRedeemed {
            collateral_mint: ctx.accounts.vault_config.collateral_mint,
            redeemer: ctx.accounts.redeemer.key(),
            shares_burned: shares,
            collateral_out: net,
            fee,
        });
        Ok(())
    }

    /// Publish a read-only [`VaultProof`] snapshot anyone can verify.
    ///
    /// Anyone may call (the publisher pays the rent). The snapshot records
    /// the ACTUAL vault token-account balance as `total_collateral`, the
    /// bookkeeping liabilities as `outstanding_claims`, and
    /// `collateral_ratio_bps = floor(balance * 10000 / claims)`
    /// (`u64::MAX` when there are no claims).
    pub fn publish_proof(ctx: Context<PublishProof>) -> Result<()> {
        // The vault collateral account is PDA-bound by the constraint above;
        // pin its Token-2022 program ownership explicitly too.
        require_token_2022_owned(
            &ctx.accounts.vault_collateral_account.to_account_info(),
        )?;
        let balance = ctx.accounts.vault_collateral_account.amount;
        let claims = ctx.accounts.vault_config.total_collateral;
        let ratio: u64 = if claims == 0 {
            u64::MAX
        } else {
            let ratio128 = (balance as u128)
                .checked_mul(BPS_DENOMINATOR)
                .ok_or(VaultError::MathOverflow)?
                .checked_div(claims as u128)
                .ok_or(VaultError::MathOverflow)?;
            u64::try_from(ratio128).map_err(|_| VaultError::MathOverflow)?
        };

        let proof = &mut ctx.accounts.proof;
        proof.vault = ctx.accounts.vault_config.key();
        proof.total_collateral = balance;
        proof.outstanding_claims = claims;
        proof.collateral_ratio_bps = ratio;
        proof.authority = ctx.accounts.vault_config.authority;
        proof.treasury = ctx.accounts.vault_config.treasury;
        proof.is_mock_collateral = ctx.accounts.vault_config.is_mock_collateral;
        proof.published_ts = ctx.accounts.clock.unix_timestamp;

        emit!(ProofPublished {
            collateral_mint: ctx.accounts.vault_config.collateral_mint,
            collateral_ratio_bps: ratio,
            published_ts: proof.published_ts,
        });
        Ok(())
    }

    /// Rotate the vault authority. Current authority only.
    pub fn update_vault_authority(
        ctx: Context<VaultAdmin>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            VaultError::InvalidPubkey
        );
        let old_authority = ctx.accounts.vault_config.authority;
        ctx.accounts.vault_config.authority = new_authority;
        emit!(VaultAuthorityUpdated {
            vault: ctx.accounts.vault_config.key(),
            old_authority,
            new_authority,
        });
        Ok(())
    }

    /// Rotate the fee-recipient treasury. Current authority only.
    ///
    /// The treasury pubkey recorded at init binds every future fee payout
    /// (redeem requires the fee account to be owned by it). Without a
    /// rotation path, a lost or compromised treasury key would strand all
    /// future fees in token accounts no one can move. Rotation takes effect
    /// for redemptions after this transaction; fees already paid out are
    /// unaffected.
    pub fn update_vault_treasury(
        ctx: Context<VaultAdmin>,
        new_treasury: Pubkey,
    ) -> Result<()> {
        require!(
            new_treasury != Pubkey::default(),
            VaultError::InvalidPubkey
        );
        let old_treasury = ctx.accounts.vault_config.treasury;
        ctx.accounts.vault_config.treasury = new_treasury;
        emit!(VaultTreasuryUpdated {
            vault: ctx.accounts.vault_config.key(),
            old_treasury,
            new_treasury,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Integer ceiling division: `ceil(a / b)`.
fn ceil_div(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, VaultError::MathOverflow);
    // Equivalent to (a + b - 1) / b without the intermediate overflow risk.
    Ok(a / b + u128::from(a % b > 0))
}

/// User-supplied token accounts must be owned by the Token-2022 program:
/// `InterfaceAccount<TokenAccount>` alone also accepts legacy Token-program
/// accounts, whose identical base layout could otherwise smuggle in an
/// account for the same mint created under the wrong program.
fn require_token_2022_owned(account_info: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        *account_info.owner,
        token_2022::ID,
        VaultError::NotToken2022
    );
    Ok(())
}

/// Solvency invariant: the vault's collateral token account must hold at
/// least the outstanding contractual claims (`total_collateral`). Checked
/// after every state-changing instruction; direct donations into the vault
/// account can only raise the balance, never break this.
fn assert_solvent(
    config: &VaultConfig,
    vault_collateral_account: &mut InterfaceAccount<TokenAccount>,
) -> Result<()> {
    vault_collateral_account.reload()?;
    require!(
        vault_collateral_account.amount >= config.total_collateral,
        VaultError::Insolvent
    );
    Ok(())
}

/// Honesty-critical collateral-mint gate.
///
/// Parses the mint's Token-2022 extensions and allow-lists ONLY
/// `MetadataPointer`, `TokenMetadata`, and `MintCloseAuthority`. Anything
/// else — permanent delegate, transfer fees, transfer hooks, default-frozen
/// state, non-transferable, the confidential-transfer suite, CPI guard,
/// interest-bearing, scaled UI amounts, pausable, group extensions — is
/// rejected with [`VaultError::InvalidCollateralMint`].
///
/// NOTE: this policy explicitly rejects the real PAXG mint in Stage 3. The
/// native Solana PAXG mint (`5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW`)
/// carries a permanent delegate (plus confidential transfers and a mint
/// close authority under the same compliance key), so [`initialize_vault`]
/// fails for it. Accepting real PAXG is a Stage-4 decision that must be made
/// as an explicit per-mint allow-list entry after direct Paxos confirmation
/// of the mint and a threat model covering those authorities — never by
/// widening this rule.
///
/// Returns the mint's decimals on success.
fn validate_collateral_mint(mint: &InterfaceAccount<Mint>) -> Result<u8> {
    require_keys_eq!(
        *mint.to_account_info().owner,
        token_2022::ID,
        VaultError::NotToken2022
    );
    let decimals = {
        let mint_info = mint.to_account_info();
        let data = mint_info.try_borrow_data()?;
        let state = spl_token_2022::extension::StateWithExtensions::<
            spl_token_2022::state::Mint,
        >::unpack(&data)
        .map_err(|_| VaultError::InvalidCollateralMint)?;
        require!(
            state.base.is_initialized,
            VaultError::InvalidCollateralMint
        );
        for extension_type in state
            .get_extension_types()
            .map_err(|_| VaultError::InvalidCollateralMint)?
        {
            require!(
                matches!(
                    extension_type,
                    spl_token_2022::extension::ExtensionType::MetadataPointer
                        | spl_token_2022::extension::ExtensionType::TokenMetadata
                        | spl_token_2022::extension::ExtensionType::MintCloseAuthority
                ),
                VaultError::InvalidCollateralMint
            );
        }
        state.base.decimals
    };
    Ok(decimals)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
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
    /// The collateral mint (real PAXG only after Paxos verification in
    /// Stage 4; mock on devnet). Must pass the extension allow-list.
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: Share mint PDA `[b"vault-shares", vault]`; created in the
    /// instruction body (Token-2022, MetadataPointer + TokenMetadata only).
    /// The PDA is derived and asserted with find_program_address before
    /// creation, so no type-level check is needed.
    #[account(mut)]
    pub share_mint: UncheckedAccount<'info>,
    /// CHECK: Vault's collateral token account PDA `[b"vault-collateral", vault]`,
    /// owned by the vault PDA; created in the instruction body. The PDA is
    /// derived and asserted with find_program_address before use.
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
    /// Collateral mint; must be the vault's recorded mint (decimals source).
    #[account(
        constraint = collateral_mint.key() == vault_config.collateral_mint
            @ VaultError::InvalidCollateralMint
    )]
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    /// The depositor's Token-2022 collateral account. Mint and program are
    /// verified in the instruction body; the transfer CPI enforces the
    /// depositor's authority over it.
    #[account(mut)]
    pub depositor_collateral_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"vault-collateral", vault_config.key().as_ref()],
        bump,
    )]
    pub vault_collateral_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"vault-shares", vault_config.key().as_ref()],
        bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,
    /// Depositor's share token account (ATA); created if missing, with the
    /// depositor as payer.
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = share_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_program,
    )]
    pub depositor_share_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
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
    /// Collateral mint; must be the vault's recorded mint (decimals source).
    #[account(
        constraint = collateral_mint.key() == vault_config.collateral_mint
            @ VaultError::InvalidCollateralMint
    )]
    pub collateral_mint: InterfaceAccount<'info, Mint>,
    /// The redeemer's share token account. Mint and program are verified in
    /// the body; the burn CPI enforces the redeemer's authority over it.
    #[account(mut)]
    pub redeemer_share_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"vault-shares", vault_config.key().as_ref()],
        bump,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [b"vault-collateral", vault_config.key().as_ref()],
        bump,
    )]
    pub vault_collateral_account: InterfaceAccount<'info, TokenAccount>,
    /// Redeemer's Token-2022 collateral account (receives the net payout).
    /// Mint and program are verified in the body; the owner may be anyone.
    #[account(mut)]
    pub redeemer_collateral_account: InterfaceAccount<'info, TokenAccount>,
    /// Fee recipient's Token-2022 collateral account. Must be for the
    /// collateral mint and owned by the recorded treasury pubkey.
    #[account(mut)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
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
    /// Read-only proof snapshot PDA; (re)created by this instruction.
    #[account(
        init_if_needed,
        payer = publisher,
        space = VaultProof::SPACE,
        seeds = [b"vault-proof", vault_config.key().as_ref()],
        bump,
    )]
    pub proof: Account<'info, VaultProof>,
    #[account(
        seeds = [b"vault-collateral", vault_config.key().as_ref()],
        bump,
    )]
    pub vault_collateral_account: InterfaceAccount<'info, TokenAccount>,
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
    /// Fee recipient (defaults to the initializing authority; rotated with
    /// `update_vault_treasury`, which the current authority may call).
    pub treasury: Pubkey,
    /// Total collateral units held (bookkeeping; verified against the token
    /// account by the solvency invariant).
    pub total_collateral: u64,
    /// Total outstanding shares.
    pub total_shares: u64,
    /// Max fraction of the vault withdrawable per redemption, in bps.
    pub withdrawal_limit_bps: u16,
    /// Redemption fee in bps, rounded up.
    pub redeem_fee_bps: u16,
    /// True on devnet: the collateral is a mock asset, never real PAXG.
    /// Recorded declaration — the program cannot verify the cluster.
    pub is_mock_collateral: bool,
    /// Unmistakable label, e.g. "MOCK-GOLD — NOT PAXG, NO VALUE".
    pub mock_label: String,
    pub bump: u8,
}

impl VaultConfig {
    /// 8 + 32*4 + 8 + 8 + 2 + 2 + 1 + (4 + 64) + 1 = 226.
    pub const SPACE: usize = 8 + 32 * 4 + 8 + 8 + 2 + 2 + 1 + (4 + MAX_MOCK_LABEL_LEN) + 1;
}

/// Independent, read-only proof snapshot: balance, liabilities, ratio,
/// authority configuration. Published on demand; anyone can recompute it.
#[account]
pub struct VaultProof {
    pub vault: Pubkey,
    /// Collateral units in the vault token account at publish time.
    pub total_collateral: u64,
    /// Outstanding contractual claims (bookkeeping `total_collateral`).
    pub outstanding_claims: u64,
    /// floor(balance * 10000 / claims); u64::MAX if no claims.
    pub collateral_ratio_bps: u64,
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub is_mock_collateral: bool,
    pub published_ts: i64,
}

impl VaultProof {
    /// 8 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 8 = 137.
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
    pub withdrawal_limit_bps: u16,
    pub redeem_fee_bps: u16,
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

#[event]
pub struct VaultAuthorityUpdated {
    pub vault: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

#[event]
pub struct VaultTreasuryUpdated {
    pub vault: Pubkey,
    pub old_treasury: Pubkey,
    pub new_treasury: Pubkey,
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
    #[msg("This program only operates with the Token-2022 program.")]
    NotToken2022,
    #[msg("Mock label must be non-empty and at most 64 bytes for mock collateral, and empty otherwise.")]
    InvalidMockLabel,
    #[msg("Share mint does not match the vault configuration.")]
    InvalidShareMint,
    #[msg("Insufficient shares for this redemption.")]
    InsufficientShares,
    #[msg("Treasury account is not a Token-2022 account for the vault collateral owned by the recorded treasury.")]
    InvalidTreasuryAccount,
    #[msg("Pubkey must not be the default (all-zero) address.")]
    InvalidPubkey,
}
