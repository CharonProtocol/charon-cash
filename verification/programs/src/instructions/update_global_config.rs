// User-owned. Regenerating the spec does NOT overwrite this file.
// Guard checks live in the sibling `crate::guards` module and ARE
// regenerated on every `qedgen codegen`.

use crate::errors::*;
use crate::guards;
use crate::state::*;
use pinocchio::{account_info::AccountInfo, program_error::ProgramError, ProgramResult};
use zeropod::ZeroPodFixed;

pub struct UpdateGlobalConfig<'a> {
    pub global_config: &'a AccountInfo,
    pub authority: &'a AccountInfo,
}

impl UpdateGlobalConfig<'_> {
    pub fn handler(
        &mut self,
        deposit_fee_rate: u16,
        withdrawal_fee_rate: u16,
        fee_error_margin: u16,
    ) -> ProgramResult {
        guards::update_global_config(
            self,
            deposit_fee_rate,
            withdrawal_fee_rate,
            fee_error_margin,
        )?;
        Ok(())
    }
}

/// Entrypoint wrapper — binds the account slice + parses params, then
/// calls `UpdateGlobalConfig::handler`. Invoked by `process_instruction` in lib.rs.
pub fn process_update_global_config(
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let [global_config, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    // TODO: parse non-numeric param `deposit_fee_rate` (spec type Bps) from instruction_data
    let deposit_fee_rate: u16 = todo!("parse deposit_fee_rate from instruction_data");
    // TODO: parse non-numeric param `withdrawal_fee_rate` (spec type Bps) from instruction_data
    let withdrawal_fee_rate: u16 = todo!("parse withdrawal_fee_rate from instruction_data");
    // TODO: parse non-numeric param `fee_error_margin` (spec type Bps) from instruction_data
    let fee_error_margin: u16 = todo!("parse fee_error_margin from instruction_data");
    let mut ctx = UpdateGlobalConfig {
        global_config,
        authority,
    };
    ctx.handler(deposit_fee_rate, withdrawal_fee_rate, fee_error_margin)
}
