use crate::{
    constants::{
        GLOBAL_CONFIG_ADDRESS, UPDATE_DEPOSIT_FEE, UPDATE_FEE_ERROR_MARGIN, UPDATE_WITHDRAWAL_FEE,
        VALID_MASK,
    },
    helper::{
        verify_address, verify_authority, verify_basis_points, verify_initialized, verify_signer,
    },
    state::GlobalConfig,
};

use bytemuck::{from_bytes_mut, Pod, Zeroable};

use pinocchio::{error::ProgramError, AccountView, ProgramResult};

#[repr(C)]
#[derive(Pod, Zeroable, Clone, Copy)]
pub struct UpdateGlobalConfigParams {
    pub deposit_fee_rate: u16,    // basis points (0-10000, where 10000 = 100%)
    pub withdrawal_fee_rate: u16, // basis points (0-10000, where 10000 = 100%)
    pub fee_error_margin: u16,    // basis points (0-10000, where 10000 = 100%)

    pub update_mask: u8, // bitmask to indicate which fields have been updated

    pub _padding: u8,
}

pub fn process_update_global_config(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [global_config, authority, _remaining @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(authority)?;
    verify_initialized(global_config)?;
    verify_address(global_config, &GLOBAL_CONFIG_ADDRESS)?;

    if !global_config.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }

    let params = bytemuck::try_pod_read_unaligned::<UpdateGlobalConfigParams>(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    if params.update_mask & !VALID_MASK != 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    if params.update_mask == 0 {
        return Ok(());
    }

    let mut global_config_data = global_config.try_borrow_mut()?;

    let global_config =
        from_bytes_mut::<GlobalConfig>(&mut global_config_data[..GlobalConfig::LEN]);

    verify_authority(&global_config.authority, authority)?;

    if params.update_mask & UPDATE_DEPOSIT_FEE != 0 {
        verify_basis_points(params.deposit_fee_rate)?;
        global_config.deposit_fee_rate = params.deposit_fee_rate;
    }

    if params.update_mask & UPDATE_WITHDRAWAL_FEE != 0 {
        verify_basis_points(params.withdrawal_fee_rate)?;
        global_config.withdrawal_fee_rate = params.withdrawal_fee_rate;
    }

    if params.update_mask & UPDATE_FEE_ERROR_MARGIN != 0 {
        verify_basis_points(params.fee_error_margin)?;
        global_config.fee_error_margin = params.fee_error_margin;
    }

    Ok(())
}
