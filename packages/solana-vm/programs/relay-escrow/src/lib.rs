use anchor_lang::{
    prelude::*,
    solana_program::{
        program::invoke,
        program::invoke_signed,
        system_instruction,
        hash::{hash, Hash},
        instruction::Instruction,
        sysvar,
    },
};

use anchor_spl::{
    token::{self, Token, TokenAccount, Transfer},
    associated_token::{AssociatedToken, Create}
};

//----------------------------------------
// Program ID
//----------------------------------------
declare_id!("2eAeUDN5EpxUB8ebCPu2HNnC9r1eJ3m2JSXGUWdxCMJg");

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

    // Deposit SOL to program vault
    pub fn deposit_sol(ctx: Context<DepositSol>, amount: u64, id: [u8; 32]) -> Result<()> {
        invoke(
            &system_instruction::transfer(
                ctx.accounts.depositor.key,
                &ctx.accounts.vault.key(),
                amount,
            ),
            &[
                ctx.accounts.depositor.to_account_info(),
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

    // Deposit SPL token to program vault
    pub fn deposit_token(
        ctx: Context<DepositToken>,
        amount: u64,
        id: [u8; 32],
    ) -> Result<()> {
        // Create ATA for vault if needed
        if ctx.accounts.vault_token_account.data_is_empty() {
            anchor_spl::associated_token::create(
                CpiContext::new(
                    ctx.accounts.associated_token_program.to_account_info(),
                    Create {
                        payer: ctx.accounts.depositor.to_account_info(),
                        associated_token: ctx.accounts.vault_token_account.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        system_program: ctx.accounts.system_program.to_account_info(),
                        token_program: ctx.accounts.token_program.to_account_info(),
                    },
                ),
            )?;
        }

        // Transfer tokens to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
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
    pub fn execute_transfer(
        ctx: Context<ExecuteTransfer>,
        request: TransferRequest,
    ) -> Result<()> {
        let relay_escrow = &ctx.accounts.relay_escrow;
        let used_request = &mut ctx.accounts.used_request;
        let vault_bump = relay_escrow.vault_bump;
        
        require!(!used_request.is_used, CustomError::RequestAlreadyUsed);

        let clock: Clock = Clock::get()?;
        require!(
            clock.unix_timestamp < request.expiration,
            CustomError::SignatureExpired
        );

        // Validate allocator signature
        let cur_index:usize = sysvar::instructions::load_current_index_checked(&ctx.accounts.ix_sysvar)?.into();
        assert!(cur_index > 0, "cur_index should be greater than 0");

        let ed25519_instr_index = cur_index - 1;
        let signature_ix = sysvar::instructions::load_instruction_at_checked(ed25519_instr_index, &ctx.accounts.ix_sysvar)?;
        
        validate_ed25519_signature_instruction(
            &signature_ix,
            &relay_escrow.allocator,
            &request,
        )?;

        used_request.is_used = true;

        // Execute transfer based on token type
        match request.token {
            // Transfer SOL
            None => {
                let vault_seeds: &[&[u8]] = &[b"vault", &[vault_bump]];
                invoke_signed(
                    &system_instruction::transfer(
                        &ctx.accounts.vault.key(),
                        &ctx.accounts.recipient.key(),
                        request.amount
                    ),
                    &[
                        ctx.accounts.vault.to_account_info(),
                        ctx.accounts.recipient.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                    &[vault_seeds],
                )?;
            }
            // Transfer SPL token
            Some(token_mint) => {
                let mint = ctx.accounts.mint.as_ref()
                    .ok_or(CustomError::InvalidMint)?;
                
                require_keys_eq!(
                    token_mint,
                    mint.key(),
                    CustomError::InvalidMint
                );

                let vault_token = ctx.accounts.vault_token_account.as_ref()
                    .ok_or(CustomError::InvalidMint)?;
                let recipient_token = ctx.accounts.recipient_token_account.as_ref()
                    .ok_or(CustomError::InvalidMint)?;

                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: vault_token.to_account_info(),
                            to: recipient_token.to_account_info(),
                            authority: ctx.accounts.vault.to_account_info(),
                        },
                        &[&[b"vault", &[vault_bump]]],
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
pub struct RelayEscrow {
    pub owner: Pubkey,
    pub allocator: Pubkey,
    pub vault_bump: u8,
}

#[account]
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
        space = 8 + 32 + 32 + 1, // discriminator(8) + owner(32) + allocator(32) + vault_bump(1)
        seeds = [b"relay_escrow"],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,

    /// CHECK: PDA that will hold SOL
    #[account(
        mut,
        seeds = [b"vault"],
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
    #[account(mut)]
    pub relay_escrow: Account<'info, RelayEscrow>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct DepositSol<'info> {
    #[account(
        seeds = [b"relay_escrow"],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,
    
    #[account(mut)]
    pub depositor: Signer<'info>,

    /// CHECK: PDA vault for SOL
    #[account(
        mut,
        seeds = [b"vault"],
        bump = relay_escrow.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositToken<'info> {
    #[account(
        seeds = [b"relay_escrow"],
        bump
    )]
    pub relay_escrow: Account<'info, RelayEscrow>,
    
    #[account(mut)]
    pub depositor: Signer<'info>,
    
    pub mint: Account<'info, token::Mint>,
    
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = depositor
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,
    
    /// CHECK: Will be initialized if needed
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    
    /// CHECK: PDA that will hold tokens
    #[account(
        seeds = [b"vault"],
        bump = relay_escrow.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request: TransferRequest)]
pub struct ExecuteTransfer<'info> {
    pub relay_escrow: Account<'info, RelayEscrow>,
    
    #[account(mut)]
    pub executor: Signer<'info>,
    
    /// CHECK: Transfer recipient
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    
    /// CHECK: SOL vault PDA
    #[account(
        mut,
        seeds = [b"vault"],
        bump = relay_escrow.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    pub mint: Option<Account<'info, token::Mint>>,
    
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = vault
    )]
    pub vault_token_account: Option<Account<'info, TokenAccount>>,
    
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient
    )]
    pub recipient_token_account: Option<Account<'info, TokenAccount>>,
    
    #[account(
        init,
        payer = executor,
        space = 8 + 1,
        seeds = [
            b"used_request",
            &request.get_hash().to_bytes()[..],
        ],
        bump
    )]
    pub used_request: Account<'info, UsedRequest>,
    
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: For ed25519 verification
    pub ix_sysvar: AccountInfo<'info>,
}

//----------------------------------------
// Custom Types
//----------------------------------------
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct TransferRequest {
    pub recipient: Pubkey,
    pub token: Option<Pubkey>,  // None for SOL, Some(mint) for SPL tokens
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
    pub token: Option<Pubkey>,  // None for SOL, Some(mint) for SPL tokens
    pub amount: u64,
    pub id: [u8; 32],
}

//----------------------------------------
// Error Definitions
//----------------------------------------
#[error_code]
pub enum CustomError {
    #[msg("Request has already been executed")]
    RequestAlreadyUsed,
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
}

//----------------------------------------
// Helper Functions
//----------------------------------------
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
    require!(signature_ix.accounts.is_empty(), CustomError::MalformedEd25519Data);

    // Extract and verify signer public key bytes
    let signer_pubkey = &signature_ix.data[16..16 + 32];
    require!(
        signer_pubkey == expected_signer.to_bytes(),
        CustomError::AllocatorSignerMismatch
    );

    // Verify signed message matches request
    let mut verified_message = &data[112..];
    let deserialized_request = TransferRequest::deserialize(&mut verified_message)?;
    require_eq!(
        deserialized_request.get_hash(),
        expected_request.get_hash(),
        CustomError::MessageMismatch
    );

    Ok(())
}