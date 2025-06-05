use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Token, TokenAccount},
};
use relay_escrow::program::RelayEscrow;

declare_id!("FEdx57eQ7pATqyPNZnW3EWBdhvfapXBz4WMo2Qk5Cm6h");

#[program]
pub mod relay_forwarder {
    use super::*;

    /// Forwards native tokens from the forwarder account to the relay escrow vault
    pub fn forward_native(ctx: Context<ForwardNative>, id: [u8; 32]) -> Result<()> {
        let amount = ctx.accounts.forwarder.lamports();
        require!(amount > 0, ForwarderError::InsufficientBalance);

        relay_escrow::cpi::deposit_native(
            CpiContext::new(
                ctx.accounts.relay_escrow_program.to_account_info(),
                ctx.accounts.into_deposit_accounts(),
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

        relay_escrow::cpi::deposit_token(
            CpiContext::new(
                ctx.accounts.relay_escrow_program.to_account_info(),
                ctx.accounts.into_deposit_accounts(),
            ),
            forwarder_token_balance,
            id,
        )?;

        if should_close {
            let close_account_cpi_ctx = CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                CloseAccount {
                    account: ctx.accounts.forwarder_token_account.to_account_info(),
                    destination: ctx.accounts.forwarder.to_account_info(),
                    authority: ctx.accounts.forwarder.to_account_info(),
                },
            );
            token::close_account(close_account_cpi_ctx)?;
        }

        Ok(())
    }
}

// Account structure for forwarding native tokens
#[derive(Accounts)]
#[instruction(
    id: [u8; 32],
)]
pub struct ForwardNative<'info> {
    // The forwarder account that holds and will send the tokens
    #[account(mut)]
    pub forwarder: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

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
#[instruction(
    id: [u8; 32],
)]
pub struct ForwardToken<'info> {
    // The forwarder account that holds and will send the tokens
    #[account(mut)]
    pub forwarder: Signer<'info>,

    /// CHECK: Used as public key only
    pub depositor: UncheckedAccount<'info>,

    /// CHECK: Relay escrow program account
    pub relay_escrow: UncheckedAccount<'info>,

    /// CHECK: Relay escrow vault
    pub relay_vault: UncheckedAccount<'info>,

    pub mint: Account<'info, token::Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = forwarder
    )]
    pub forwarder_token_account: Account<'info, TokenAccount>,

    /// CHECK: Relay escrow vault token account
    #[account(mut)]
    pub relay_vault_token: UncheckedAccount<'info>,

    pub relay_escrow_program: Program<'info, relay_escrow::program::RelayEscrow>,
    pub token_program: Program<'info, Token>,
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
