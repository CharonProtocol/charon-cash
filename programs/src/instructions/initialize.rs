// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`.

use crate::errors::*;
use crate::guards;
use crate::state::*;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};
use zeropod::ZeroPodFixed;

pub struct Initialize<'a> {
    pub tree_account: &'a AccountInfo,
    pub tree_token_account: &'a AccountInfo,
    pub global_config: &'a AccountInfo,
    pub authority: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl Initialize<'_> {
    pub fn handler(
        &mut self,
        initial_max_deposit_amount: u64,
        tree_account_bump: u8,
    ) -> ProgramResult {
        guards::initialize(self, initial_max_deposit_amount, tree_account_bump)?;
        let __state = PrivacyCashAccount::from_bytes_mut(unsafe {
            self.tree_account.borrow_mut_data_unchecked()
        })
        .map_err(|_| ProgramError::InvalidAccountData)?;
        __state.authority = (*self.authority.key()).into();
        __state.max_deposit_amount = (initial_max_deposit_amount).into();
        __state.bump = (tree_account_bump).into();
        Ok(())
    }
}

/// Entrypoint wrapper — binds the account slice + parses params, then
/// calls `Initialize::handler`. Invoked by `process_instruction` in lib.rs.
pub fn process_initialize(accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
    let [tree_account, tree_token_account, global_config, authority, system_program, ..] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let initial_max_deposit_amount = u64::from_le_bytes(
        instruction_data
            .get(0..8)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let tree_account_bump = u8::from_le_bytes(
        instruction_data
            .get(8..9)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let mut ctx = Initialize {
        tree_account,
        tree_token_account,
        global_config,
        authority,
        system_program,
    };
    ctx.handler(initial_max_deposit_amount, tree_account_bump)
}
