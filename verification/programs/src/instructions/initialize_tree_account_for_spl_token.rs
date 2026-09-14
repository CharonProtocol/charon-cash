// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`.

use crate::errors::*;
use crate::guards;
use crate::state::*;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};
use zeropod::ZeroPodFixed;

pub struct InitializeTreeAccountForSplToken<'a> {
    pub tree_account: &'a AccountInfo,
    pub mint: &'a AccountInfo,
    pub global_config: &'a AccountInfo,
    pub authority: &'a AccountInfo,
    pub system_program: &'a AccountInfo,
}

impl InitializeTreeAccountForSplToken<'_> {
    pub fn handler(
        &mut self,
        initial_max_deposit_amount: u64,
        tree_account_bump: u8,
    ) -> ProgramResult {
        guards::initialize_tree_account_for_spl_token(
            self,
            initial_max_deposit_amount,
            tree_account_bump,
        )?;
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
/// calls `InitializeTreeAccountForSplToken::handler`. Invoked by `process_instruction` in lib.rs.
pub fn process_initialize_tree_account_for_spl_token(
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let [tree_account, mint, global_config, authority, system_program, ..] = accounts else {
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
    let mut ctx = InitializeTreeAccountForSplToken {
        tree_account,
        mint,
        global_config,
        authority,
        system_program,
    };
    ctx.handler(initial_max_deposit_amount, tree_account_bump)
}
