use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{close_account, TokenInterface, TokenAccount, CloseAccount, Mint},
};
use relay_escrow::program::RelayEscrow;
use anchor_lang::system_program;

// Seed for forwarder PDA
pub const FORWARDER_SEED: &[u8] = b"forwarder";

declare_id!("EbWguaxgPD4DFqUwPKRohRkh1LQhNvAKxbvEXFrSx9bc");

#[program]
pub mod relay_forwarder {
    use super::*;

    /// Forwards native tokens from the forwarder account to the relay escrow vault
    pub fn forward_native(
        ctx: Context<ForwardNative>,
        id: [u8; 32],
    ) -> Result<()> {
        let amount = ctx.accounts.forwarder.lamports();
        require!(amount > 0, ForwarderError::InsufficientBalance);

        let sender_key = ctx.accounts.sender.key();
        let forwarder_bump = ctx.bumps.forwarder;
        let forwarder_seeds = &[
            FORWARDER_SEED,
            sender_key.as_ref(),
            id.as_ref(),
            &[forwarder_bump],
        ];

        relay_escrow::cpi::deposit_native(
            CpiContext::new_with_signer(
                ctx.accounts.relay_escrow_program.to_account_info(),
                ctx.accounts.into_deposit_accounts(),
                &[forwarder_seeds]
            ),
            amount,
            id,
        )?;

        Ok(())
    }

    /// Forwards spl tokens from the forwarder's token account to the relay escrow vault token account
    pub fn forward_token(
        ctx: Context<ForwardToken>,
        id: [u8; 32],
        should_close: bool,
    ) -> Result<()> {
        let forwarder_token_balance = ctx.accounts.forwarder_token_account.amount;
        require!(
            forwarder_token_balance > 0,
            ForwarderError::InsufficientBalance
        );

        let sender = ctx.accounts.sender.key();
        let seeds = &[
            FORWARDER_SEED,
            sender.as_ref(),
            id.as_ref(),
            &[ctx.bumps.forwarder],
        ];

        let signer_seeds = &[&seeds[..]];

        relay_escrow::cpi::deposit_token(
            CpiContext::new_with_signer(
                ctx.accounts.relay_escrow_program.to_account_info(),
                ctx.accounts.into_deposit_accounts(),
                signer_seeds
            ),
            forwarder_token_balance,
            id,
        )?;

        if should_close {
            let close_account_cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.forwarder_token_account.to_account_info(),
                    destination: ctx.accounts.forwarder.to_account_info(),
                    authority: ctx.accounts.forwarder.to_account_info(),
                },
                signer_seeds
            );
            close_account(close_account_cpi_ctx)?;
        }

        Ok(())
    }
}

// Account structure for forwarding native tokens
#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct ForwardNative<'info> {

    // User who initiates the forward
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Forwarder PDA that will act as the intermediary
    #[account(
        mut,
        seeds = [
            FORWARDER_SEED,
            sender.key().as_ref(),
            id.as_ref()
        ],
        bump
    )]
    pub forwarder: UncheckedAccount<'info>,

    /// CHECK: Relay escrow program account
    pub relay_escrow: UncheckedAccount<'info>,

    /// CHECK: Relay escrow vault
    #[account(mut)]
    pub relay_vault: UncheckedAccount<'info>,

    pub relay_escrow_program: Program<'info, relay_escrow::program::RelayEscrow>,
    pub system_program: Program<'info, System>,
}

impl<'info> ForwardNative<'info> {
    /// Converts `ForwardNative` accounts into `relay_escrow::cpi::accounts::DepositNative`
    /// accounts for use in cross-program-invocation calls to the `relay_escrow`` program
    fn into_deposit_accounts(&self) -> relay_escrow::cpi::accounts::DepositNative<'info> {
        relay_escrow::cpi::accounts::DepositNative {
            relay_escrow: self.relay_escrow.to_account_info(),
            depositor: self.depositor.to_account_info(),
            sender: self.forwarder.to_account_info(),
            vault: self.relay_vault.to_account_info(),
            system_program: self.system_program.to_account_info(),
        }
    }
}

// Account structure for forwarding spl tokens
#[derive(Accounts)]
#[instruction(id: [u8; 32], should_close: bool)]
pub struct ForwardToken<'info> {
    // User who initiates the forward
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Forwarder PDA that will act as the intermediary
    #[account(
        mut,
        seeds = [
            FORWARDER_SEED,
            sender.key().as_ref(),
            id.as_ref()
        ],
        bump
    )]
    pub forwarder: UncheckedAccount<'info>,

    /// CHECK: Relay escrow program account
    pub relay_escrow: UncheckedAccount<'info>,

    /// CHECK: Relay escrow vault
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

    /// CHECK: Relay escrow vault token account
    #[account(mut)]
    pub relay_vault_token: UncheckedAccount<'info>,

    pub relay_escrow_program: Program<'info, relay_escrow::program::RelayEscrow>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> ForwardToken<'info> {
    /// Converts `ForwardToken` accounts into `relay_escrow::cpi::accounts::DepositToken`
    /// accounts for use in cross-program-invocation calls to the `relay_escrow`` program
    fn into_deposit_accounts(&self) -> relay_escrow::cpi::accounts::DepositToken<'info> {
        relay_escrow::cpi::accounts::DepositToken {
            relay_escrow: self.relay_escrow.to_account_info(),
            depositor: self.depositor.to_account_info(),
            sender: self.forwarder.to_account_info(),
            mint: self.mint.to_account_info(),
            sender_token_account: self.forwarder_token_account.to_account_info(),
            vault_token_account: self.relay_vault_token.to_account_info(),
            vault: self.relay_vault.to_account_info(),
            token_program: self.token_program.to_account_info(),
            associated_token_program: self.associated_token_program.to_account_info(),
            system_program: self.system_program.to_account_info(),
        }
    }
}

#[error_code]
pub enum ForwarderError {
    #[msg("Insufficient balance")]
    InsufficientBalance,
}

/// Closes an account by transferring all lamports to the `sol_destination`.
///
/// Lifted from private `anchor_lang::common::close`: https://github.com/coral-xyz/anchor/blob/714d5248636493a3d1db1481f16052836ee59e94/lang/src/common.rs#L6
pub fn close<'info>(info: AccountInfo<'info>, sol_destination: AccountInfo<'info>) -> Result<()> {
    // Transfer tokens from the account to the sol_destination.
    let dest_starting_lamports = sol_destination.lamports();
    **sol_destination.lamports.borrow_mut() =
        dest_starting_lamports.checked_add(info.lamports()).unwrap();
    **info.lamports.borrow_mut() = 0;

    info.assign(&system_program::ID);
    info.realloc(0, false).map_err(Into::into)
}