use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{close_account, CloseAccount, Mint, TokenAccount, TokenInterface},
};
use relay_depository::program::RelayDepository;

//----------------------------------------
// Constants
//----------------------------------------

const RELAY_FORWARDER_SEED: &[u8] = b"relay_forwarder";

//----------------------------------------
// Program ID
//----------------------------------------

declare_id!("G67218pYuajgSWAFa5qDgxFJDAc41NTbLfLEz46WQ9M6");

//----------------------------------------
// Program Module
//----------------------------------------

#[program]
pub mod relay_forwarder {
    use super::*;

    /// Forwards native tokens from the forwarder account to the relay depository vault account
    pub fn forward_native(ctx: Context<ForwardNative>, id: [u8; 32]) -> Result<()> {
        let amount = ctx.accounts.forwarder.lamports();

        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(0);

        // Check that the forwarder has more than the minimum required amount
        require!(amount > min_rent, ForwarderError::InsufficientBalance);

        let seeds: &[&[&[u8]]] = &[&[RELAY_FORWARDER_SEED, &[ctx.bumps.forwarder]]];

        relay_depository::cpi::deposit_native(
            CpiContext::new_with_signer(
                ctx.accounts.relay_depository_program.to_account_info(),
                ctx.accounts.into_deposit_accounts(),
                seeds,
            ),
            // Only forward the amount above rent-exempt threshold
            amount - min_rent,
            id,
        )?;

        Ok(())
    }

    /// Forwards spl tokens from the forwarder token account to the relay depository vault token account
    pub fn forward_token(ctx: Context<ForwardToken>, id: [u8; 32]) -> Result<()> {
        let amount = ctx.accounts.forwarder_token_account.amount;
        require!(amount > 0, ForwarderError::InsufficientBalance);

        let seeds: &[&[&[u8]]] = &[&[RELAY_FORWARDER_SEED, &[ctx.bumps.forwarder]]];

        relay_depository::cpi::deposit_token(
            CpiContext::new_with_signer(
                ctx.accounts.relay_depository_program.to_account_info(),
                ctx.accounts.into_deposit_accounts(),
                seeds,
            ),
            amount,
            id,
        )?;

        let close_account_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.forwarder_token_account.to_account_info(),
                destination: ctx.accounts.sender.to_account_info(),
                authority: ctx.accounts.forwarder.to_account_info(),
            },
            seeds,
        );
        close_account(close_account_cpi_ctx)?;

        Ok(())
    }
}

//----------------------------------------
// Instruction Contexts
//----------------------------------------

// Account structure for forwarding native tokens
#[derive(Accounts)]
#[instruction(
    id: [u8; 32],
)]
pub struct ForwardNative<'info> {
    // User who initiates the forward
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Forwarder PDA that will act as the intermediary
    #[account(
        mut,
        seeds = [RELAY_FORWARDER_SEED],
        bump
    )]
    pub forwarder: UncheckedAccount<'info>,

    /// CHECK: Relay depository program account
    pub relay_depository: UncheckedAccount<'info>,

    /// CHECK: Relay depository vault
    #[account(mut)]
    pub relay_vault: UncheckedAccount<'info>,

    pub relay_depository_program: Program<'info, relay_depository::program::RelayDepository>,
    pub system_program: Program<'info, System>,
}

impl<'info> ForwardNative<'info> {
    /// Converts `ForwardNative` accounts into `relay_depository::cpi::accounts::DepositNative`
    /// accounts for use in cross-program-invocation calls to the `relay_depository` program
    fn into_deposit_accounts(&self) -> relay_depository::cpi::accounts::DepositNative<'info> {
        relay_depository::cpi::accounts::DepositNative {
            relay_depository: self.relay_depository.to_account_info(),
            depositor: self.depositor.to_account_info(),
            sender: self.forwarder.to_account_info(),
            vault: self.relay_vault.to_account_info(),
            system_program: self.system_program.to_account_info(),
        }
    }
}

// Account structure for forwarding spl tokens
#[derive(Accounts)]
#[instruction(
    id: [u8; 32],
)]
pub struct ForwardToken<'info> {
    // User who initiates the forward
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Forwarder PDA that will act as the intermediary
    #[account(
        mut,
        seeds = [RELAY_FORWARDER_SEED],
        bump
    )]
    pub forwarder: UncheckedAccount<'info>,

    /// CHECK: Relay depository program account
    pub relay_depository: UncheckedAccount<'info>,

    /// CHECK: Relay depository vault
    pub relay_vault: UncheckedAccount<'info>,

    /// CHECK: Token mint account
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Associated token account for the forwarder PDA
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = forwarder,
        associated_token::token_program = token_program
    )]
    pub forwarder_token_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Relay depository vault token account
    #[account(mut)]
    pub relay_vault_token_account: UncheckedAccount<'info>,

    pub relay_depository_program: Program<'info, relay_depository::program::RelayDepository>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> ForwardToken<'info> {
    /// Converts `ForwardToken` accounts into `relay_depository::cpi::accounts::DepositToken`
    /// accounts for use in cross-program-invocation calls to the `relay_depository`` program
    fn into_deposit_accounts(&self) -> relay_depository::cpi::accounts::DepositToken<'info> {
        relay_depository::cpi::accounts::DepositToken {
            relay_depository: self.relay_depository.to_account_info(),
            depositor: self.depositor.to_account_info(),
            sender: self.forwarder.to_account_info(),
            mint: self.mint.to_account_info(),
            sender_token_account: self.forwarder_token_account.to_account_info(),
            vault_token_account: self.relay_vault_token_account.to_account_info(),
            vault: self.relay_vault.to_account_info(),
            token_program: self.token_program.to_account_info(),
            associated_token_program: self.associated_token_program.to_account_info(),
            system_program: self.system_program.to_account_info(),
        }
    }
}

//----------------------------------------
// Error Definitions
//----------------------------------------

#[error_code]
pub enum ForwarderError {
    #[msg("Insufficient balance")]
    InsufficientBalance,
}
