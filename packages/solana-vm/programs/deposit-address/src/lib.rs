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
            DepositAddressError::Unauthorized
        );
        config.owner = new_owner;
        Ok(())
    }

    /// Sweep native SOL from a deposit address PDA to the relay depository vault
    ///
    /// Transfers SOL from the deposit address PDA to the vault via CPI call
    /// to relay_depository::deposit_native. Leaves rent-exempt minimum in the PDA.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `id` - The unique identifier (32 bytes)
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn sweep_native(ctx: Context<SweepNative>, id: [u8; 32]) -> Result<()> {
        let amount = ctx.accounts.deposit_address.lamports();

        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(0);

        // Check that the deposit address has more than the minimum required amount
        require!(amount > min_rent, DepositAddressError::InsufficientBalance);

        let token_bytes = Pubkey::default().to_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            DEPOSIT_ADDRESS_SEED,
            &id[..],
            &token_bytes,
            &[ctx.bumps.deposit_address],
        ]];

        relay_depository::cpi::deposit_native(
            CpiContext::new_with_signer(
                ctx.accounts.relay_depository_program.to_account_info(),
                ctx.accounts.into_deposit_native_accounts(),
                seeds,
            ),
            amount - min_rent,
            id,
        )?;

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
    #[account(
        init,
        payer = owner,
        space = 8 + DepositAddressConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        constraint = owner.key() == AUTHORIZED_PUBKEY @ DepositAddressError::Unauthorized,
        bump
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// The owner account that pays for initialization
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: Validated as relay_depository PDA
    pub relay_depository: UncheckedAccount<'info>,

    /// The relay depository program
    pub relay_depository_program: Program<'info, RelayDepository>,

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

/// Accounts required for sweeping native SOL from a deposit address
#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct SweepNative<'info> {
    /// The configuration account
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        has_one = relay_depository,
        has_one = vault,
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// CHECK: Deposit address PDA derived from id and default token
    #[account(
        mut,
        seeds = [DEPOSIT_ADDRESS_SEED, &id[..], &Pubkey::default().to_bytes()],
        bump
    )]
    pub deposit_address: UncheckedAccount<'info>,

    /// CHECK: Used as public key only for event emission
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Validated via config.has_one
    pub relay_depository: UncheckedAccount<'info>,

    /// CHECK: Validated via config.has_one
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    /// The relay depository program
    #[account(
        constraint = relay_depository_program.key() == config.relay_depository_program
    )]
    pub relay_depository_program: Program<'info, RelayDepository>,

    /// The system program
    pub system_program: Program<'info, System>,
}

impl<'info> SweepNative<'info> {
    /// Converts `SweepNative` accounts into `relay_depository::cpi::accounts::DepositNative`
    /// accounts for use in cross-program-invocation calls to the `relay_depository` program
    fn into_deposit_native_accounts(&self) -> relay_depository::cpi::accounts::DepositNative<'info> {
        relay_depository::cpi::accounts::DepositNative {
            relay_depository: self.relay_depository.to_account_info(),
            sender: self.deposit_address.to_account_info(),
            depositor: self.depositor.to_account_info(),
            vault: self.vault.to_account_info(),
            system_program: self.system_program.to_account_info(),
        }
    }
}

//----------------------------------------
// Error Definitions
//----------------------------------------

/// Custom error codes for the deposit address program
#[error_code]
pub enum DepositAddressError {
    /// Thrown when the deposit address has insufficient balance to sweep
    #[msg("Insufficient balance")]
    InsufficientBalance,

    /// Thrown when an account attempts an operation it is not authorized for
    #[msg("Unauthorized")]
    Unauthorized,
}
