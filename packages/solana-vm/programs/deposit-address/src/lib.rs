use anchor_lang::prelude::*;
use relay_depository::program::RelayDepository;

///
/// A Solana deposit address program built with the Anchor framework.
/// This program creates deterministic deposit addresses (PDAs) for each order,
/// allowing non-custodial deposits that can be swept to the relay depository vault.
///

//----------------------------------------
// Constants
//----------------------------------------

const AUTHORIZED_PUBKEY: Pubkey = pubkey!("7LZXYdDQcRTsXnL9EU2zGkninV3yJsqX43m4RMPbs68u");

const CONFIG_SEED: &[u8] = b"config";

#[allow(dead_code)]
const DEPOSIT_ADDRESS_SEED: &[u8] = b"deposit_address";

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("CMEh4xH7ercsXoyRC2QFTgqEjECCkkS7oSmj7qvPw8MX");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod deposit_address {
    use super::*;

    /// Initialize the deposit address program configuration
    ///
    /// Creates and initializes the configuration account with the relay depository
    /// program information for cross-program invocation.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.relay_depository = ctx.accounts.relay_depository.key();
        config.relay_depository_program = ctx.accounts.relay_depository_program.key();
        config.vault = ctx.accounts.vault.key();

        Ok(())
    }

    /// Transfer ownership of the deposit address program to a new owner
    ///
    /// Allows the current owner to transfer ownership to a new public key.
    /// Only the current owner can call this instruction.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_owner` - The public key of the new owner
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_owner(ctx: Context<SetOwner>, new_owner: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            config.owner,
            ErrorCode::Unauthorized
        );
        config.owner = new_owner;
        Ok(())
    }
}

//----------------------------------------
// Account Structures
//----------------------------------------

/// Deposit address configuration that stores relay depository information
///
/// This account is a PDA derived from the `CONFIG_SEED` and
/// contains the relay depository program and vault addresses.
#[account]
#[derive(InitSpace)]
pub struct DepositAddressConfig {
    /// The owner who can update settings and execute admin operations
    pub owner: Pubkey,
    /// The relay depository account address
    pub relay_depository: Pubkey,
    /// The relay depository program ID
    pub relay_depository_program: Pubkey,
    /// The vault PDA address
    pub vault: Pubkey,
}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

/// Accounts required for initializing the deposit address program
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The configuration account to be initialized
    /// This is a PDA derived from the CONFIG_SEED
    #[account(
        init,
        payer = owner,
        space = 8 + DepositAddressConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        constraint = owner.key() == AUTHORIZED_PUBKEY @ ErrorCode::Unauthorized,
        bump
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// The owner account that pays for initialization
    /// Must match the AUTHORIZED_PUBKEY
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The relay depository account
    /// CHECK: Validated as relay_depository PDA
    pub relay_depository: UncheckedAccount<'info>,

    /// The relay depository program
    pub relay_depository_program: Program<'info, RelayDepository>,

    /// The vault PDA
    /// CHECK: Validated as vault PDA
    pub vault: UncheckedAccount<'info>,

    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for transferring ownership
#[derive(Accounts)]
pub struct SetOwner<'info> {
    /// The configuration account to update
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// The current owner of the deposit address program
    pub owner: Signer<'info>,
}

//----------------------------------------
// Error Definitions
//----------------------------------------

/// Custom error codes for the deposit address program
#[error_code]
pub enum ErrorCode {
    /// Thrown when the deposit address has insufficient balance to sweep
    #[msg("Insufficient balance")]
    InsufficientBalance,

    /// Thrown when an account attempts an operation it is not authorized for
    #[msg("Unauthorized")]
    Unauthorized,
}
