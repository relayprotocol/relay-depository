use anchor_lang::{
    prelude::*,
    solana_program::{
        hash::{hash, Hash},
        instruction::Instruction,
        program::invoke,
        program::invoke_signed,
        system_instruction, sysvar,
    },
};
use anchor_spl::token::Token;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{transfer_fee::TransferFeeConfig, BaseStateWithExtensions, StateWithExtensions},
};
use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken, Create},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

/// 
/// A Solana relay depository smart contract built with the Anchor framework. 
/// This contract allows users to deposit SOL or SPL tokens and execute transfers with verified signatures.
/// 

/// 
//----------------------------------------
// Constants
//----------------------------------------

const AUTHORIZED_PUBKEY: Pubkey = pubkey!("7LZXYdDQcRTsXnL9EU2zGkninV3yJsqX43m4RMPbs68u");

const RELAY_DEPOSITORY_SEED: &[u8] = b"relay_depository";

const USED_REQUEST_SEED: &[u8] = b"used_request";

const VAULT_SEED: &[u8] = b"vault";

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod relay_depository {
    use super::*;

    /// Initialize the relay depository program with owner and allocator
    ///
    /// Creates and initializes the relay depository account with the specified
    /// owner and allocator.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let relay_depository = &mut ctx.accounts.relay_depository;
        relay_depository.owner = ctx.accounts.owner.key();
        relay_depository.allocator = ctx.accounts.allocator.key();
        relay_depository.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Update the allocator public key
    ///
    /// Allows the owner to change the authorized allocator that can sign transfer requests.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_allocator` - The public key of the new allocator
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_allocator(ctx: Context<SetAllocator>, new_allocator: Pubkey) -> Result<()> {
        let relay_depository = &mut ctx.accounts.relay_depository;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            relay_depository.owner,
            CustomError::Unauthorized
        );
        relay_depository.allocator = new_allocator;
        Ok(())
    }

    /// Update the owner public key
    ///
    /// Allows the current owner to transfer ownership to a new address.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `new_owner` - The public key of the new owner
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if not authorized
    pub fn set_owner(ctx: Context<SetOwner>, new_owner: Pubkey) -> Result<()> {
        let relay_depository = &mut ctx.accounts.relay_depository;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            relay_depository.owner,
            CustomError::Unauthorized
        );
        relay_depository.owner = new_owner;
        Ok(())
    }


    /// Deposit native SOL tokens into the vault
    ///
    /// Transfers SOL from the sender to the vault and emits a deposit event.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `amount` - The amount of SOL to deposit
    /// * `id` - A unique identifier for the deposit
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn deposit_native(ctx: Context<DepositNative>, amount: u64, id: [u8; 32]) -> Result<()> {
        // Transfer to vault
        invoke(
            &system_instruction::transfer(
                ctx.accounts.sender.key,
                &ctx.accounts.vault.key(),
                amount,
            ),
            &[
                ctx.accounts.sender.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            token: None,
            amount,
            id,
        });

        Ok(())
    }

    /// Deposit SPL tokens into the vault
    ///
    /// Creates the vault's token account if needed, transfers tokens from the sender,
    /// and emits a deposit event.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `amount` - The amount of tokens to deposit
    /// * `id` - A unique identifier for the deposit
    ///
    /// # Returns
    /// * `Ok(())` on success
    pub fn deposit_token(ctx: Context<DepositToken>, amount: u64, id: [u8; 32]) -> Result<()> {
        // Create associated token account for the vault if needed
        if ctx.accounts.vault_token_account.data_is_empty() {
            anchor_spl::associated_token::create(CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                Create {
                    payer: ctx.accounts.sender.to_account_info(),
                    associated_token: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ))?;
        }

        let expected_vault_ata = get_associated_token_address_with_program_id(
            &ctx.accounts.vault.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.token_program.key(),
        );

        // Check if the vault token account is the expected associated token account
        require_keys_eq!(
            ctx.accounts.vault_token_account.key(),
            expected_vault_ata,
            CustomError::InvalidVaultTokenAccount
        );

        // Calculate transfer fee
        let mint = &ctx.accounts.mint;
        let transfer_fee = get_transfer_fee(mint, amount)?;

        // Transfer to vault
        transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            mint.decimals,
        )?;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            token: Some(ctx.accounts.mint.key()),
            amount: amount - transfer_fee,
            id,
        });

        Ok(())
    }

    /// Execute a transfer with allocator signature
    ///
    /// Verifies the allocator's signature, transfers tokens to the recipient,
    /// and marks the request as used.
    ///
    /// # Parameters
    /// * `ctx` - The context containing the accounts
    /// * `request` - The transfer request details and signature
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(error)` if signature is invalid or request can't be processed
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, request: TransferRequest) -> Result<()> {
        let relay_depository = &ctx.accounts.relay_depository;
        let used_request = &mut ctx.accounts.used_request;
        let vault_bump = relay_depository.vault_bump;

        require!(
            !used_request.is_used,
            CustomError::TransferRequestAlreadyUsed
        );

        let clock: Clock = Clock::get()?;
        require!(
            clock.unix_timestamp < request.expiration,
            CustomError::SignatureExpired
        );

        // Validate allocator signature
        let cur_index: usize =
            sysvar::instructions::load_current_index_checked(&ctx.accounts.ix_sysvar)?.into();
        assert!(cur_index > 0, "cur_index should be greater than 0");

        let ed25519_instr_index = cur_index - 1;
        let signature_ix = sysvar::instructions::load_instruction_at_checked(
            ed25519_instr_index,
            &ctx.accounts.ix_sysvar,
        )?;

        validate_ed25519_signature_instruction(
            &signature_ix,
            &relay_depository.allocator,
            &request,
        )?;

        used_request.is_used = true;

        let seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];

        // Execute the transfer based on the token type
        match request.token {
            // Transfer native
            None => {
                require_keys_eq!(
                    ctx.accounts.recipient.key(),
                    request.recipient,
                    CustomError::InvalidRecipient
                );

                // Ensure vault maintains rent-exempt status after transfer
                let min_rent = Rent::get()?.minimum_balance(0);
                let vault_balance = ctx.accounts.vault.lamports();
                let max_transferable = vault_balance.saturating_sub(min_rent);
                require!(
                    request.amount <= max_transferable,
                    CustomError::InsufficientVaultBalance
                );

                invoke_signed(
                    &system_instruction::transfer(
                        &ctx.accounts.vault.key(),
                        &ctx.accounts.recipient.key(),
                        request.amount,
                    ),
                    &[
                        ctx.accounts.vault.to_account_info(),
                        ctx.accounts.recipient.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    &[seeds],
                )?;
            }
            // Transfer token
            Some(token_mint) => {
                let mint = ctx.accounts.mint.as_ref().ok_or(CustomError::InvalidMint)?;

                require_keys_eq!(token_mint, mint.key(), CustomError::InvalidMint);

                let vault_token_account = ctx
                    .accounts
                    .vault_token_account
                    .as_ref()
                    .ok_or(CustomError::InvalidMint)?;
                let recipient_token_account = ctx
                    .accounts
                    .recipient_token_account
                    .as_ref()
                    .ok_or(CustomError::InvalidMint)?;

                require_keys_eq!(
                    recipient_token_account.owner,
                    request.recipient,
                    CustomError::InvalidRecipient
                );
                transfer_checked(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        TransferChecked {
                            mint: mint.to_account_info(),
                            from: vault_token_account.to_account_info(),
                            to: recipient_token_account.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[seeds],
                    ),
                    request.amount,
                    mint.decimals,
                )?;
            }
        }

        emit!(TransferExecutedEvent {
            id: used_request.key(),
            request: request.clone(),
            executor: ctx.accounts.executor.key(),
        });

        Ok(())
    }
}

//----------------------------------------
// Account Structures
//----------------------------------------

/// Relay depository account that stores configuration and state
/// 
/// This account is a PDA derived from the `RELAY_DEPOSITORY_SEED` and
/// contains the ownership and allocation information.
#[account]
#[derive(InitSpace)]
pub struct RelayDepository {
    /// The owner of the relay depository who can update settings
    pub owner: Pubkey,
    /// The authorized allocator that can sign transfer requests
    pub allocator: Pubkey,
    /// The bump seed for the vault PDA, used for deriving the vault address
    pub vault_bump: u8,
}

/// Account that tracks whether a transfer request has been used
/// 
/// This account is created for each transfer request to prevent replay attacks.
#[account]
#[derive(InitSpace)]
pub struct UsedRequest {
    /// Flag indicating whether the request has been processed
    pub is_used: bool,
}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

/// Accounts required for initializing the relay depository
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// The relay depository account to be initialized
    /// This is a PDA derived from the RELAY_DEPOSITORY_SEED
    #[account(
        init,
        payer = owner,
        space = 8 + RelayDepository::INIT_SPACE,
        seeds = [RELAY_DEPOSITORY_SEED],
        constraint = owner.key() == AUTHORIZED_PUBKEY @ CustomError::Unauthorized,
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// PDA that will hold SOL deposits
    /// This is a PDA derived from the VAULT_SEED
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The owner account that pays for initialization
    /// Must match the AUTHORIZED_PUBKEY
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The allocator account that will be authorized to sign transfer requests
    /// Used as public key only
    pub allocator: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Accounts required for updating the allocator
#[derive(Accounts)]
pub struct SetAllocator<'info> {
    /// The relay depository account to update
    #[account(
        mut,
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The owner of the relay depository
    pub owner: Signer<'info>,
}

/// Accounts required for updating the owner
#[derive(Accounts)]
pub struct SetOwner<'info> {
    /// The relay depository account to update
    #[account(
        mut,
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The current owner of the relay depository
    pub owner: Signer<'info>,
}

/// Accounts required for depositing native currency
#[derive(Accounts)]
pub struct DepositNative<'info> {
    /// The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The sender of the deposit
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The account credited for the deposit
    pub depositor: UncheckedAccount<'info>,

    /// The vault PDA that will receive the SOL
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The system program
    pub system_program: Program<'info, System>,
}

/// Accounts required for depositing tokens
#[derive(Accounts)]
pub struct DepositToken<'info> {
    /// The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The sender of the deposit
    #[account(mut)]
    pub sender: Signer<'info>,

    /// The account credited for the deposit
    pub depositor: UncheckedAccount<'info>,

    /// The vault PDA that will receive the tokens
    #[account(
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The mint of the token being deposited
    pub mint: InterfaceAccount<'info, Mint>,

    /// The sender's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender,
        associated_token::token_program = token_program
    )]
    pub sender_token_account: InterfaceAccount<'info, TokenAccount>,

    /// The vault's token account
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,

    /// The token program
    pub token_program: Interface<'info, TokenInterface>,
    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Accounts required for executing a transfer
#[derive(Accounts)]
#[instruction(request: TransferRequest)]
pub struct ExecuteTransfer<'info> {
    /// The relay depository account
    #[account(
        seeds = [RELAY_DEPOSITORY_SEED],
        bump
    )]
    pub relay_depository: Account<'info, RelayDepository>,

    /// The executor of the transfer
    #[account(mut)]
    pub executor: Signer<'info>,

    /// The recipient of the transfer
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// The vault PDA that will receive the tokens
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_depository.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// The mint of the token being transferred
    pub mint: Option<InterfaceAccount<'info, Mint>>,

    /// The recipient's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// The vault's token account
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    /// The account that tracks whether a transfer request has been used
    /// 
    /// This account is created for each transfer request to prevent replay attacks.
    #[account(
        init,
        payer = executor,
        space = 8 + UsedRequest::INIT_SPACE,
        seeds = [
            USED_REQUEST_SEED,
            &request.get_hash().to_bytes()[..],
        ],
        bump
    )]
    pub used_request: Account<'info, UsedRequest>,

    /// The instruction sysvar for ed25519 verification
    pub ix_sysvar: AccountInfo<'info>,

    /// The token program
    pub token_program: Interface<'info, TokenInterface>,
    /// The associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// The system program
    pub system_program: Program<'info, System>,
}

//----------------------------------------
// Custom Types
//----------------------------------------

/// Structure representing a transfer request signed by the allocator
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct TransferRequest {
    /// The recipient of the transfer
    pub recipient: Pubkey,
    /// The token mint (None for native SOL, Some(mint) for SPL tokens)
    pub token: Option<Pubkey>,
    /// The amount to transfer
    pub amount: u64,
    /// A unique nonce
    pub nonce: u64,
    /// The expiration timestamp for the request
    pub expiration: i64,
}

impl TransferRequest {
    /// Computes a hash of the serialized request for signature verification
    /// and used request tracking
    pub fn get_hash(&self) -> Hash {
        hash(&self.try_to_vec().unwrap())
    }
}

//----------------------------------------
// Events
//----------------------------------------

/// Event emitted when a transfer is executed
#[event]
pub struct TransferExecutedEvent {
    /// The transfer request that was executed
    pub request: TransferRequest,
    /// The public key of the executor who processed the transfer
    pub executor: Pubkey,
    /// The unique identifier for the used request account
    pub id: Pubkey,
}

/// Event emitted when a deposit is made
#[event]
pub struct DepositEvent {
    /// The public key of the depositor
    pub depositor: Pubkey,
    /// The token mint (None for native SOL, Some(mint) for SPL tokens)
    pub token: Option<Pubkey>,
    /// The amount deposited
    pub amount: u64,
    /// A unique identifier for the deposit
    pub id: [u8; 32],
}

//----------------------------------------
// Error Definitions
//----------------------------------------

/// Custom error codes for the relay depository program
#[error_code]
pub enum CustomError {
    /// Thrown when trying to execute a transfer request that has already been used
    #[msg("Transfer request has already been executed")]
    TransferRequestAlreadyUsed,

    /// Thrown when the provided mint does not match the expected mint
    #[msg("Invalid mint")]
    InvalidMint,

    /// Thrown when an account attempts an operation it is not authorized for
    #[msg("Unauthorized")]
    Unauthorized,

    /// Thrown when the signature's signer doesn't match the expected allocator
    #[msg("Allocator signer mismatch")]
    AllocatorSignerMismatch,

    /// Thrown when the signed message doesn't match the expected request
    #[msg("Message mismatch")]
    MessageMismatch,

    /// Thrown when the Ed25519 signature data is malformed
    #[msg("Malformed Ed25519 data")]
    MalformedEd25519Data,

    /// Thrown when a required signature is missing
    #[msg("Missing signature")]
    MissingSignature,

    /// Thrown when the signature has expired
    #[msg("Signature expired")]
    SignatureExpired,

    /// Thrown when the recipient doesn't match the expected recipient
    #[msg("Invalid recipient")]
    InvalidRecipient,

    /// Thrown when the vault token account doesn't match the expected address
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount,

    /// Thrown when a transfer would leave the vault with insufficient balance for rent
    #[msg("Vault has insufficient balance to remain rent-exempt after transfer")]
    InsufficientVaultBalance,
}

//----------------------------------------
// Helper Functions
//----------------------------------------

/// Validates an Ed25519 signature instruction
///
/// Verifies that the signature instruction is properly formatted,
/// signed by the expected signer, and matches the expected request.
///
/// # Parameters
/// * `signature_ix` - The signature instruction to validate
/// * `expected_signer` - The expected signer of the instruction
/// * `expected_request` - The expected transfer request that was signed
///
/// # Returns
/// * `Ok(())` if the signature is valid
/// * `Err(error)` if the signature is invalid
fn validate_ed25519_signature_instruction(
    signature_ix: &Instruction,
    expected_signer: &Pubkey,
    expected_request: &TransferRequest,
) -> Result<()> {

    // Taken from:
    // https://github.com/solana-labs/perpetuals/blob/ebfb4972ea5d1cde8580a7e8c7b9dbd1fdb2b002/programs/perpetuals/src/instructions/set_custom_oracle_price_permissionless.rs#L90
    // Verify program ID
    require_eq!(
        signature_ix.program_id,
        solana_program::ed25519_program::id(),
        CustomError::MissingSignature
    );

    let data = &signature_ix.data;

    // Validate signature data structure
    require!(data.len() >= 99, CustomError::MalformedEd25519Data);
    require_eq!(data[0], 1, CustomError::MalformedEd25519Data);
    require!(
        signature_ix.accounts.is_empty(),
        CustomError::MalformedEd25519Data
    );

    // Extract and verify signer public key bytes
    let signer_pubkey = &signature_ix.data[16..16 + 32];
    require!(
        signer_pubkey == expected_signer.to_bytes(),
        CustomError::AllocatorSignerMismatch
    );

    // Verify message hash matches request hash
    let message_hash = &data[112..112 + 32];
    let expected_hash = expected_request.get_hash().to_bytes();
    if message_hash != expected_hash {
        return Err(CustomError::MessageMismatch.into());
    }

    Ok(())
}


/// Calculates the transfer fee for a token
///
/// Determines the fee amount for the given mint and transfer amount,
/// taking into account the token extension for transfer fees if present.
///
/// # Parameters
/// * `mint_account` - The mint account of the token
/// * `pre_fee_amount` - The amount to transfer before fees
///
/// # Returns
/// * The calculated fee amount
pub fn get_transfer_fee(mint_account: &InterfaceAccount<Mint>, pre_fee_amount: u64) -> Result<u64> {
    /// Taken from:
    /// https://github.com/raydium-io/raydium-clmm/blob/eb7c392be9c8ef8af6eefb92ff834fc41ab975e3/programs/amm/src/util/token.rs#L218C1-L238C2
    let mint_info = mint_account.to_account_info();
    if *mint_info.owner == Token::id() {
        return Ok(0);
    }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

    let fee = if let Ok(transfer_fee_config) = mint.get_extension::<TransferFeeConfig>() {
        transfer_fee_config
            .calculate_epoch_fee(Clock::get()?.epoch, pre_fee_amount)
            .unwrap()
    } else {
        0
    };
    Ok(fee)
}
