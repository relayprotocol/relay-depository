use anchor_lang::{
    prelude::*,
    solana_program::{program::invoke, system_instruction},
};
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount};

declare_id!("DzACDmwdqc5ADPJKnZEcQAgpsPdvYzvYBMihPNN48pFE");

#[program]
pub mod forwarder {
    use super::*;

    pub fn unwrap_wsol(ctx: Context<UnwrapWsol>) -> Result<()> {
        // TODO: Any funds available in the associated token account of this program should be sent to "relay_escrow"

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Forward<'info> {
    // TODO
}
