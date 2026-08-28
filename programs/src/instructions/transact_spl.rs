// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`.

use crate::errors::*;
use crate::guards;
use crate::state::*;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};
use zeropod::ZeroPodFixed;

pub struct TransactSpl<'a> {
    pub tree_account: &'a AccountInfo,
    pub nullifier0: &'a AccountInfo,
    pub nullifier1: &'a AccountInfo,
    pub nullifier2: &'a AccountInfo,
    pub nullifier3: &'a AccountInfo,
    pub global_config: &'a AccountInfo,
    pub signer: &'a AccountInfo,
    pub mint: &'a AccountInfo,
    pub signer_token_account: &'a AccountInfo,
    pub recipient: &'a AccountInfo,
    pub recipient_token_account: &'a AccountInfo,
    pub tree_ata: &'a AccountInfo,
    pub fee_recipient_ata: &'a AccountInfo,
    pub token_program: &'a AccountInfo,
    pub associated_token_program: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl TransactSpl<'_> {
    pub fn handler(&mut self, ext_amount: i64, fee: u64) -> ProgramResult {
        guards::transact_spl(self, ext_amount, fee)?;
        Ok(())
    }
}

/// Entrypoint wrapper — binds the account slice + parses params, then
/// calls `TransactSpl::handler`. Invoked by `process_instruction` in lib.rs.
pub fn process_transact_spl(accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
    let [tree_account, nullifier0, nullifier1, nullifier2, nullifier3, global_config, signer, mint, signer_token_account, recipient, recipient_token_account, tree_ata, fee_recipient_ata, token_program, associated_token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let ext_amount = i64::from_le_bytes(
        instruction_data
            .get(0..8)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let fee = u64::from_le_bytes(
        instruction_data
            .get(8..16)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let mut ctx = TransactSpl {
        tree_account,
        nullifier0,
        nullifier1,
        nullifier2,
        nullifier3,
        global_config,
        signer,
        mint,
        signer_token_account,
        recipient,
        recipient_token_account,
        tree_ata,
        fee_recipient_ata,
        token_program,
        associated_token_program,
        system_program,
    };
    ctx.handler(ext_amount, fee)
}
