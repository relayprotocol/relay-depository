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

use anchor_spl::{
    associated_token::{get_associated_token_address_with_program_id, AssociatedToken, Create},
    token_interface::{transfer, Mint, TokenAccount, TokenInterface, Transfer},
};

//----------------------------------------
// Constants
//----------------------------------------

const AUTHORIZED_PUBKEY: Pubkey = pubkey!("7LZXYdDQcRTsXnL9EU2zGkninV3yJsqX43m4RMPbs68u");

const RELAY_ESCROW_SEED: &[u8] = b"relay_escrow";

const USED_REQUEST_SEED: &[u8] = b"used_request";

const VAULT_SEED: &[u8] = b"vault";

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("4s6BJkymabK7o275uaThj5zaPybLovbMdjtHAvyM6T92");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod relay_escrow {
    use super::*;

    // Initialize program with owner and allocator
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let relay_escrow = &mut ctx.accounts.relay_escrow;
        relay_escrow.owner = ctx.accounts.owner.key();
        relay_escrow.allocator = ctx.accounts.allocator.key();
        relay_escrow.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    // Update allocator
    pub fn set_allocator(ctx: Context<SetAllocator>, new_allocator: Pubkey) -> Result<()> {
        let relay_escrow = &mut ctx.accounts.relay_escrow;
        require_keys_eq!(
            ctx.accounts.owner.key(),
            relay_escrow.owner,
            CustomError::Unauthorized
        );
        relay_escrow.allocator = new_allocator;
        Ok(())
    }

    // Deposit native tokens
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

    // Deposit spl tokens
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

        // Transfer to vault
        transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            token: Some(ctx.accounts.mint.key()),
            amount,
            id,
        });

        Ok(())
    }

    // Execute transfer with allocator signature
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, request: TransferRequest) -> Result<()> {
        let relay_escrow = &ctx.accounts.relay_escrow;
        let used_request = &mut ctx.accounts.used_request;
        let vault_bump = relay_escrow.vault_bump;

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

        validate_ed25519_signature_instruction(&signature_ix, &relay_escrow.allocator, &request)?;

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
                transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: vault_token_account.to_account_info(),
                            to: recipient_token_account.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[seeds],
                    ),
                    request.amount,
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

#[account]
#[derive(InitSpace)]
pub struct RelayEscrow {
    pub owner: Pubkey,
    pub allocator: Pubkey,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UsedRequest {
    pub is_used: bool,
}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + RelayEscrow::INIT_SPACE,
        seeds = [RELAY_ESCROW_SEED],
        constraint = owner.key() == AUTHORIZED_PUBKEY @ CustomError::Unauthorized,
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,

    /// CHECK: PDA that will hold SOL
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: Used as public key only
    pub allocator: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAllocator<'info> {
    #[account(
        mut,
        seeds = [RELAY_ESCROW_SEED],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositNative<'info> {
    #[account(
        seeds = [RELAY_ESCROW_SEED],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: PDA vault that will hold tokens
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_escrow.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToken<'info> {
    #[account(
        seeds = [RELAY_ESCROW_SEED],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: PDA that will hold tokens
    #[account(
        seeds = [VAULT_SEED],
        bump = relay_escrow.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender,
        associated_token::token_program = token_program
    )]
    pub sender_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Will be initialized if needed
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request: TransferRequest)]
pub struct ExecuteTransfer<'info> {
    #[account(
        seeds = [RELAY_ESCROW_SEED],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,

    #[account(mut)]
    pub executor: Signer<'info>,

    /// CHECK: Transfer recipient
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    /// CHECK: Native token vault PDA
    #[account(
        mut,
        seeds = [VAULT_SEED],
        bump = relay_escrow.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub mint: Option<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program
    )]
    pub vault_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

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

    /// CHECK: For ed25519 verification
    pub ix_sysvar: AccountInfo<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

//----------------------------------------
// Custom Types
//----------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct TransferRequest {
    pub recipient: Pubkey,
    pub token: Option<Pubkey>, // None for native tokens, Some(mint) for spl tokens
    pub amount: u64,
    pub nonce: u64,
    pub expiration: i64,
}

impl TransferRequest {
    pub fn get_hash(&self) -> Hash {
        hash(&self.try_to_vec().unwrap())
    }
}

//----------------------------------------
// Events
//----------------------------------------

#[event]
pub struct TransferExecutedEvent {
    pub request: TransferRequest,
    pub executor: Pubkey,
    pub id: Pubkey,
}

#[event]
pub struct DepositEvent {
    pub depositor: Pubkey,
    pub token: Option<Pubkey>, // None for native tokens, Some(mint) for spl tokens
    pub amount: u64,
    pub id: [u8; 32],
}

//----------------------------------------
// Error Definitions
//----------------------------------------

#[error_code]
pub enum CustomError {
    #[msg("Transfer request has already been executed")]
    TransferRequestAlreadyUsed,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Allocator signer mismatch")]
    AllocatorSignerMismatch,
    #[msg("Message mismatch")]
    MessageMismatch,
    #[msg("Malformed Ed25519 data")]
    MalformedEd25519Data,
    #[msg("Missing signature")]
    MissingSignature,
    #[msg("Signature expired")]
    SignatureExpired,
    #[msg("Invalid recipient")]
    InvalidRecipient,
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount,
}

//----------------------------------------
// Helper Functions
//----------------------------------------

/// Taken from:
/// https://github.com/solana-labs/perpetuals/blob/ebfb4972ea5d1cde8580a7e8c7b9dbd1fdb2b002/programs/perpetuals/src/instructions/set_custom_oracle_price_permissionless.rs#L90
fn validate_ed25519_signature_instruction(
    signature_ix: &Instruction,
    expected_signer: &Pubkey,
    expected_request: &TransferRequest,
) -> Result<()> {
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
