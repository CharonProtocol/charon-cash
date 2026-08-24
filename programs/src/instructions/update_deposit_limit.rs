// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`.

use crate::errors::*;
use crate::guards;
use crate::state::*;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};
use zeropod::ZeroPodFixed;

pub struct UpdateDepositLimit<'a> {
    pub tree_account: &'a AccountInfo,
    pub authority: &'a AccountInfo,
}

impl UpdateDepositLimit<'_> {
    pub fn handler(&mut self, new_limit: u64) -> ProgramResult {
        guards::update_deposit_limit(self, new_limit)?;
        let __state = PrivacyCashAccount::from_bytes_mut(unsafe {
            self.tree_account.borrow_mut_data_unchecked()
        })
        .map_err(|_| ProgramError::InvalidAccountData)?;
        __state.max_deposit_amount = (new_limit).into();
        Ok(())
    }
}

/// Entrypoint wrapper — binds the account slice + parses params, then
/// calls `UpdateDepositLimit::handler`. Invoked by `process_instruction` in lib.rs.
pub fn process_update_deposit_limit(
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let [tree_account, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let new_limit = u64::from_le_bytes(
        instruction_data
            .get(0..8)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let mut ctx = UpdateDepositLimit {
        tree_account,
        authority,
    };
    ctx.handler(new_limit)
}
