// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`.

use crate::errors::*;
use crate::guards;
use crate::state::*;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};
use zeropod::ZeroPodFixed;

pub struct Transact<'a> {
    pub tree_account: &'a AccountInfo,
    pub nullifier0: &'a AccountInfo,
    pub nullifier1: &'a AccountInfo,
    pub nullifier2: &'a AccountInfo,
    pub nullifier3: &'a AccountInfo,
    pub tree_token_account: &'a AccountInfo,
    pub global_config: &'a AccountInfo,
    pub recipient: &'a AccountInfo,
    pub fee_recipient_account: &'a AccountInfo,
    pub signer: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl Transact<'_> {
    pub fn handler(&mut self, ext_amount: i64, fee: u64) -> ProgramResult {
        guards::transact(self, ext_amount, fee)?;
        Ok(())
    }
}

/// Entrypoint wrapper — binds the account slice + parses params, then
/// calls `Transact::handler`. Invoked by `process_instruction` in lib.rs.
pub fn process_transact(accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
    let [tree_account, nullifier0, nullifier1, nullifier2, nullifier3, tree_token_account, global_config, recipient, fee_recipient_account, signer, system_program, ..] =
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
    let mut ctx = Transact {
        tree_account,
        nullifier0,
        nullifier1,
        nullifier2,
        nullifier3,
        tree_token_account,
        global_config,
        recipient,
        fee_recipient_account,
        signer,
        system_program,
    };
    ctx.handler(ext_amount, fee)
}
