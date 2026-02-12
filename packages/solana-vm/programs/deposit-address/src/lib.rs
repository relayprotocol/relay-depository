use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{close_account, CloseAccount, Mint, TokenAccount, TokenInterface},
};
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

const ALLOWED_PROGRAM_SEED: &[u8] = b"allowed_program";

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

        emit!(InitializeEvent {
            owner: config.owner,
            relay_depository: config.relay_depository,
            relay_depository_program: config.relay_depository_program,
            vault: config.vault,
        });

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
        let previous_owner = config.owner;
        config.owner = new_owner;

        emit!(SetOwnerEvent {
            previous_owner,
            new_owner,
        });

        Ok(())
    }

    /// Update the relay depository configuration
    ///
    /// Allows the current owner to update the relay depository, its program ID,
    /// and the vault address.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_depository(ctx: Context<SetDepository>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            config.owner,
            DepositAddressError::Unauthorized
        );

        let previous_relay_depository = config.relay_depository;
        let previous_relay_depository_program = config.relay_depository_program;
        let previous_vault = config.vault;

        config.relay_depository = ctx.accounts.relay_depository.key();
        config.relay_depository_program = ctx.accounts.relay_depository_program.key();
        config.vault = ctx.accounts.vault.key();

        emit!(SetDepositoryEvent {
            previous_relay_depository,
            previous_relay_depository_program,
            previous_vault,
            new_relay_depository: config.relay_depository,
            new_relay_depository_program: config.relay_depository_program,
            new_vault: config.vault,
        });

        Ok(())
    }

    /// Add a program to the whitelist
    ///
    /// Allows the owner to add a program to the execute whitelist.
    /// Only whitelisted programs can be called via the execute instruction.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn add_allowed_program(ctx: Context<AddAllowedProgram>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owner,
            DepositAddressError::Unauthorized
        );

        let allowed = &mut ctx.accounts.allowed_program;
        allowed.program_id = ctx.accounts.program_to_add.key();

        emit!(AddAllowedProgramEvent {
            program_id: allowed.program_id,
        });

        Ok(())
    }

    /// Remove a program from the whitelist
    ///
    /// Allows the owner to remove a program from the execute whitelist.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn remove_allowed_program(ctx: Context<RemoveAllowedProgram>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owner,
            DepositAddressError::Unauthorized
        );
        emit!(RemoveAllowedProgramEvent {
            program_id: ctx.accounts.allowed_program.program_id,
        });

        // The allowed_program account will be closed and rent returned to owner
        Ok(())
    }

    /// Sweep funds from a deposit address PDA to the relay depository vault
    ///
    /// For native SOL (mint = Pubkey::default), transfers full lamport balance via CPI
    /// to relay_depository::deposit_native.
    /// For SPL tokens, transfers token balance via CPI to relay_depository::deposit_token,
    /// then closes the deposit address's token account and returns rent to the depositor.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `id` - The unique identifier (32 bytes)
    /// * `mint` - The token mint (Pubkey::default for native SOL)
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn sweep(ctx: Context<Sweep>, id: [u8; 32], mint: Pubkey) -> Result<()> {
        let depositor_bytes = ctx.accounts.depositor.key().to_bytes();
        let mint_bytes = mint.to_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            DEPOSIT_ADDRESS_SEED,
            &id[..],
            &mint_bytes,
            &depositor_bytes,
            &[ctx.bumps.deposit_address],
        ]];

        let amount;

        match mint == Pubkey::default() {
            // Native SOL
            true => {
                amount = ctx.accounts.deposit_address.lamports();
                require!(amount > 0, DepositAddressError::InsufficientBalance);

                relay_depository::cpi::deposit_native(
                    CpiContext::new_with_signer(
                        ctx.accounts.relay_depository_program.to_account_info(),
                        relay_depository::cpi::accounts::DepositNative {
                            relay_depository: ctx.accounts.relay_depository.to_account_info(),
                            sender: ctx.accounts.deposit_address.to_account_info(),
                            depositor: ctx.accounts.depositor.to_account_info(),
                            vault: ctx.accounts.vault.to_account_info(),
                            system_program: ctx.accounts.system_program.to_account_info(),
                        },
                        seeds,
                    ),
                    amount,
                    id,
                )?;
            }
            // SPL Token
            false => {
                let mint_account = ctx
                    .accounts
                    .mint_account
                    .as_ref()
                    .ok_or(DepositAddressError::MissingTokenAccounts)?;
                let deposit_address_token_account = ctx
                    .accounts
                    .deposit_address_token_account
                    .as_ref()
                    .ok_or(DepositAddressError::MissingTokenAccounts)?;
                let vault_token_account = ctx
                    .accounts
                    .vault_token_account
                    .as_ref()
                    .ok_or(DepositAddressError::MissingTokenAccounts)?;

                require_keys_eq!(mint_account.key(), mint);

                amount = deposit_address_token_account.amount;
                require!(amount > 0, DepositAddressError::InsufficientBalance);

                relay_depository::cpi::deposit_token(
                    CpiContext::new_with_signer(
                        ctx.accounts.relay_depository_program.to_account_info(),
                        relay_depository::cpi::accounts::DepositToken {
                            relay_depository: ctx.accounts.relay_depository.to_account_info(),
                            sender: ctx.accounts.deposit_address.to_account_info(),
                            depositor: ctx.accounts.depositor.to_account_info(),
                            vault: ctx.accounts.vault.to_account_info(),
                            mint: mint_account.to_account_info(),
                            sender_token_account: deposit_address_token_account.to_account_info(),
                            vault_token_account: vault_token_account.to_account_info(),
                            token_program: ctx.accounts.token_program.to_account_info(),
                            associated_token_program: ctx
                                .accounts
                                .associated_token_program
                                .to_account_info(),
                            system_program: ctx.accounts.system_program.to_account_info(),
                        },
                        seeds,
                    ),
                    amount,
                    id,
                )?;

                // Close the deposit address token account, return rent to depositor
                close_account(CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    CloseAccount {
                        account: deposit_address_token_account.to_account_info(),
                        destination: ctx.accounts.depositor.to_account_info(),
                        authority: ctx.accounts.deposit_address.to_account_info(),
                    },
                    seeds,
                ))?;
            }
        }

        emit!(SweepEvent {
            id,
            depositor: ctx.accounts.depositor.key(),
            deposit_address: ctx.accounts.deposit_address.key(),
            mint,
            amount,
        });

        Ok(())
    }

    /// Execute arbitrary CPI from a deposit address PDA
    ///
    /// Allows the owner to execute arbitrary cross-program invocation from a deposit
    /// address PDA. This is used for handling edge cases such as recovering stuck funds,
    /// swapping unsupported tokens, or claiming airdrops.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `id` - The unique identifier (32 bytes)
    /// * `token` - The token mint used to derive the deposit address (Pubkey::default for native)
    /// * `depositor` - The depositor used to derive the deposit address
    /// * `instruction_data` - The data to pass to the target program
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn execute<'info>(
        ctx: Context<'_, '_, 'info, 'info, Execute<'info>>,
        id: [u8; 32],
        token: Pubkey,
        depositor: Pubkey,
        instruction_data: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.config.owner,
            DepositAddressError::Unauthorized
        );

        let token_bytes = token.to_bytes();
        let depositor_bytes = depositor.to_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            DEPOSIT_ADDRESS_SEED,
            &id[..],
            &token_bytes,
            &depositor_bytes,
            &[ctx.bumps.deposit_address],
        ]];

        // Build account metas from remaining accounts
        // Only the deposit_address PDA is marked as signer (signed via invoke_signed)
        let deposit_address_key = ctx.accounts.deposit_address.key();
        let account_metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|account| {
                let is_signer = account.key() == deposit_address_key;
                if account.is_writable {
                    AccountMeta::new(*account.key, is_signer)
                } else {
                    AccountMeta::new_readonly(*account.key, is_signer)
                }
            })
            .collect();

        let instruction = Instruction {
            program_id: ctx.accounts.target_program.key(),
            accounts: account_metas,
            data: instruction_data.clone(),
        };

        // Collect account infos for invoke_signed
        let mut account_infos: Vec<AccountInfo<'info>> = ctx
            .remaining_accounts
            .iter()
            .map(|a| a.to_account_info())
            .collect();
        account_infos.push(ctx.accounts.target_program.to_account_info());

        invoke_signed(&instruction, &account_infos, seeds)?;

        emit!(ExecuteEvent {
            id,
            token,
            depositor,
            target_program: ctx.accounts.target_program.key(),
            instruction_data,
        });

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

/// Represents a program that is allowed to be called via execute
///
/// This account is a PDA derived from the `ALLOWED_PROGRAM_SEED` and
/// the program's public key.
#[account]
#[derive(InitSpace)]
pub struct AllowedProgram {
    /// The program ID that is allowed
    pub program_id: Pubkey,
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

    /// CHECK: Stored in config, validated during sweep via has_one
    pub relay_depository: UncheckedAccount<'info>,

    /// The relay depository program
    pub relay_depository_program: Program<'info, RelayDepository>,

    /// CHECK: Stored in config, validated during sweep via has_one
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

/// Accounts required for updating the relay depository configuration
#[derive(Accounts)]
pub struct SetDepository<'info> {
    /// The configuration account to update
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// The current owner of the deposit address program
    pub owner: Signer<'info>,

    /// CHECK: Stored in config, validated during sweep via has_one
    pub relay_depository: UncheckedAccount<'info>,

    /// The relay depository program
    pub relay_depository_program: Program<'info, RelayDepository>,

    /// CHECK: Stored in config, validated during sweep via has_one
    pub vault: UncheckedAccount<'info>,
}

/// Accounts required for adding a program to the whitelist
#[derive(Accounts)]
pub struct AddAllowedProgram<'info> {
    /// The configuration account
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, DepositAddressConfig>,

    /// The owner who can add programs
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: The program to add to the whitelist, must be executable
    #[account(executable)]
    pub program_to_add: UncheckedAccount<'info>,

    /// The allowed program account to create
    #[account(
        init,
        payer = owner,
        space = 8 + AllowedProgram::INIT_SPACE,
        seeds = [ALLOWED_PROGRAM_SEED, program_to_add.key().as_ref()],
        bump
    )]
    pub allowed_program: Account<'info, AllowedProgram>,

    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for removing a program from the whitelist
#[derive(Accounts)]
pub struct RemoveAllowedProgram<'info> {
    /// The configuration account
    #[account(seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, DepositAddressConfig>,

    /// The owner who can remove programs
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The allowed program account to close
    #[account(
        mut,
        close = owner,
        seeds = [ALLOWED_PROGRAM_SEED, allowed_program.program_id.as_ref()],
        bump
    )]
    pub allowed_program: Account<'info, AllowedProgram>,
}

/// Accounts required for sweeping funds from a deposit address
///
/// Token-specific accounts (mint_account, deposit_address_token_account, vault_token_account)
/// are Optional — pass None for native SOL sweeps, Some for token sweeps.
/// Programs (token_program, associated_token_program) are always required.
/// Follows the same pattern as ExecuteTransfer in relay-depository.
#[derive(Accounts)]
#[instruction(id: [u8; 32], mint: Pubkey)]
pub struct Sweep<'info> {
    /// The configuration account
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        has_one = relay_depository,
        has_one = vault,
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// CHECK: Depositor address, used in PDA derivation, event emission, and receives ATA rent
    #[account(mut)]
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Deposit address PDA derived from id, mint, and depositor
    #[account(
        mut,
        seeds = [DEPOSIT_ADDRESS_SEED, &id[..], &mint.to_bytes(), depositor.key().as_ref()],
        bump
    )]
    pub deposit_address: UncheckedAccount<'info>,

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

    // Token-specific accounts (Option — None for native, Some for token)

    /// The token mint (None for native SOL)
    pub mint_account: Option<InterfaceAccount<'info, Mint>>,

    /// The deposit address's token account
    #[account(
        mut,
        associated_token::mint = mint_account,
        associated_token::authority = deposit_address,
        associated_token::token_program = token_program
    )]
    pub deposit_address_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: May need to be created by relay_depository
    #[account(mut)]
    pub vault_token_account: Option<UncheckedAccount<'info>>,

    /// The token program
    pub token_program: Interface<'info, TokenInterface>,

    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
}

/// Accounts required for executing arbitrary CPI from a deposit address
#[derive(Accounts)]
#[instruction(id: [u8; 32], token: Pubkey, depositor: Pubkey)]
pub struct Execute<'info> {
    /// The configuration account
    #[account(
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, DepositAddressConfig>,

    /// The owner of the deposit address program (only owner can execute)
    pub owner: Signer<'info>,

    /// CHECK: Deposit address PDA derived from id, token, and depositor
    #[account(
        mut,
        seeds = [DEPOSIT_ADDRESS_SEED, &id[..], &token.to_bytes(), &depositor.to_bytes()],
        bump
    )]
    pub deposit_address: UncheckedAccount<'info>,

    /// Validates target_program is in the whitelist
    #[account(
        seeds = [ALLOWED_PROGRAM_SEED, target_program.key().as_ref()],
        bump,
        constraint = allowed_program.program_id == target_program.key(),
    )]
    pub allowed_program: Account<'info, AllowedProgram>,

    /// CHECK: Target program for CPI, validated via allowed_program PDA and executable constraint
    #[account(executable)]
    pub target_program: UncheckedAccount<'info>,
}

//----------------------------------------
// Events
//----------------------------------------

/// Event emitted when the program is initialized
#[event]
pub struct InitializeEvent {
    /// The owner of the program
    pub owner: Pubkey,
    /// The relay depository account address
    pub relay_depository: Pubkey,
    /// The relay depository program ID
    pub relay_depository_program: Pubkey,
    /// The vault PDA address
    pub vault: Pubkey,
}

/// Event emitted when ownership is transferred
#[event]
pub struct SetOwnerEvent {
    /// The previous owner
    pub previous_owner: Pubkey,
    /// The new owner
    pub new_owner: Pubkey,
}

/// Event emitted when the relay depository configuration is updated
#[event]
pub struct SetDepositoryEvent {
    /// The previous relay depository address
    pub previous_relay_depository: Pubkey,
    /// The previous relay depository program ID
    pub previous_relay_depository_program: Pubkey,
    /// The previous vault address
    pub previous_vault: Pubkey,
    /// The new relay depository address
    pub new_relay_depository: Pubkey,
    /// The new relay depository program ID
    pub new_relay_depository_program: Pubkey,
    /// The new vault address
    pub new_vault: Pubkey,
}

/// Event emitted when a program is added to the whitelist
#[event]
pub struct AddAllowedProgramEvent {
    /// The program ID that was added
    pub program_id: Pubkey,
}

/// Event emitted when a program is removed from the whitelist
#[event]
pub struct RemoveAllowedProgramEvent {
    /// The program ID that was removed
    pub program_id: Pubkey,
}

/// Event emitted when funds are swept from a deposit address
#[event]
pub struct SweepEvent {
    /// The unique identifier of the deposit address
    pub id: [u8; 32],
    /// The depositor
    pub depositor: Pubkey,
    /// The deposit address PDA
    pub deposit_address: Pubkey,
    /// The token mint (Pubkey::default for native SOL)
    pub mint: Pubkey,
    /// The amount swept
    pub amount: u64,
}

/// Event emitted when an execute CPI is performed
#[event]
pub struct ExecuteEvent {
    /// The unique identifier of the deposit address
    pub id: [u8; 32],
    /// The token mint used to derive the deposit address
    pub token: Pubkey,
    /// The depositor used to derive the deposit address
    pub depositor: Pubkey,
    /// The target program that was called
    pub target_program: Pubkey,
    /// The instruction data passed to the target program
    pub instruction_data: Vec<u8>,
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

    /// Thrown when token-specific accounts are required but not provided
    #[msg("Missing token accounts")]
    MissingTokenAccounts,
}
