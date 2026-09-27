//! # alchemy_factory — experiment registry
//!
//! On-chain registry of Alchemy Factory experiments. Each experiment records
//! the mechanic family, a hash of its full configuration, the authority set,
//! and a hash of the plain-English holder-rights summary shown in the studio.
//! A disclosure event is emitted on every state change so indexers and the
//! holder app can track the experiment lifecycle.
//!
//! The registry stores *hashes*, not the configs themselves: the full config
//! lives off-chain (IPFS / studio backend) and anyone can verify it against
//! the on-chain hash.

use anchor_lang::prelude::*;

declare_id!("2KhE8tbR3jMufMA6fYsBpeNn2Es8iFw4idVzF8fZmSiQ");

#[program]
pub mod alchemy_factory {
    use super::*;

    /// Register a new experiment. The PDA is derived from the creator's
    /// authority key and a creator-chosen `experiment_id`.
    pub fn initialize_experiment(
        ctx: Context<InitializeExperiment>,
        experiment_id: u64,
        mechanic: Mechanic,
        config_hash: [u8; 32],
        holder_rights_hash: [u8; 32],
    ) -> Result<()> {
        let experiment = &mut ctx.accounts.experiment;
        experiment.mechanic = mechanic;
        experiment.config_hash = config_hash;
        experiment.authority = ctx.accounts.authority.key();
        experiment.holder_rights_hash = holder_rights_hash;
        experiment.created_at = ctx.accounts.clock.unix_timestamp;
        experiment.bump = ctx.bumps.experiment;

        emit!(ExperimentRegistered {
            experiment: experiment.key(),
            experiment_id,
            mechanic_tag: experiment.mechanic as u8,
            authority: experiment.authority,
            config_hash,
            holder_rights_hash,
            created_at: experiment.created_at,
        });
        Ok(())
    }

    /// Rotate the experiment authority. Only the current authority may call.
    /// The PDA address itself is stable across rotation (it was derived from
    /// the *original* authority); the live authority is the `authority` field.
    ///
    /// The default pubkey is rejected as the new authority: rotating to it
    /// would permanently brick admin (no key can ever sign as the default
    /// pubkey).
    pub fn update_authorities(
        ctx: Context<UpdateAuthorities>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(
            new_authority != Pubkey::default(),
            FactoryError::InvalidAuthority
        );
        let old_authority = ctx.accounts.experiment.authority;
        ctx.accounts.experiment.authority = new_authority;
        emit!(AuthoritiesUpdated {
            experiment: ctx.accounts.experiment.key(),
            old_authority,
            new_authority,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(experiment_id: u64)]
pub struct InitializeExperiment<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Experiment::SPACE,
        seeds = [b"experiment", authority.key().as_ref(), &experiment_id.to_le_bytes()],
        bump,
    )]
    pub experiment: Account<'info, Experiment>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct UpdateAuthorities<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority @ FactoryError::Unauthorized,
    )]
    pub experiment: Account<'info, Experiment>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// The five mechanic families supported by Alchemy Factory.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mechanic {
    /// Metadata/supply changes from authenticated off-chain data.
    DynamicAndEvolving,
    /// Fixed expiration plus a periodic decay schedule.
    TimeDecaying,
    /// Transferable container over a defined set of assets.
    HierarchicalNested,
    /// Bonding-curve native pricing (audited templates only).
    BondingCurveNative,
    /// Minting from a verifiable attestation.
    ProofOfX,
}

#[account]
pub struct Experiment {
    /// Which mechanic family this experiment implements.
    pub mechanic: Mechanic,
    /// SHA-256 of the full canonical experiment configuration (off-chain).
    pub config_hash: [u8; 32],
    /// Current admin authority. Only this key may rotate authorities.
    pub authority: Pubkey,
    /// SHA-256 of the plain-English holder-rights summary shown pre-deploy.
    pub holder_rights_hash: [u8; 32],
    /// Unix timestamp of registration.
    pub created_at: i64,
    pub bump: u8,
}

impl Experiment {
    /// 8 (disc) + 1 (enum) + 32 + 32 + 32 + 8 + 1.
    pub const SPACE: usize = 8 + 1 + 32 + 32 + 32 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Events (emitted on every state change)
// ---------------------------------------------------------------------------

#[event]
pub struct ExperimentRegistered {
    pub experiment: Pubkey,
    pub experiment_id: u64,
    /// Discriminant of [`Mechanic`]: 0 dynamic, 1 decaying, 2 hierarchical,
    /// 3 bonding-curve, 4 proof-of-X.
    pub mechanic_tag: u8,
    pub authority: Pubkey,
    pub config_hash: [u8; 32],
    pub holder_rights_hash: [u8; 32],
    pub created_at: i64,
}

#[event]
pub struct AuthoritiesUpdated {
    pub experiment: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum FactoryError {
    #[msg("Caller is not the experiment authority.")]
    Unauthorized,
    #[msg("Arithmetic overflow or underflow.")]
    MathOverflow,
    #[msg("New authority must not be the default pubkey (it would brick admin).")]
    InvalidAuthority,
}
