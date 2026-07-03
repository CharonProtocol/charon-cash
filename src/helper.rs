use pinocchio::{AccountView, ProgramResult};

pub fn verify_signer(account: &AccountView) -> ProgramResult {
    if !account.is_signer() {
        return Err(pinocchio::error::ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

pub fn verify_uninitialized(account: &AccountView) -> ProgramResult {
    if !account.is_data_empty() {
        return Err(pinocchio::error::ProgramError::AccountAlreadyInitialized);
    }
    Ok(())
}

pub fn verify_initialized(account: &AccountView) -> ProgramResult {
    if account.is_data_empty() {
        return Err(pinocchio::error::ProgramError::UninitializedAccount);
    }
    Ok(())
}

pub fn verify_program_id(account: &AccountView, expected: &pinocchio::Address) -> ProgramResult {
    if account.address() != expected {
        return Err(pinocchio::error::ProgramError::IncorrectProgramId);
    }
    Ok(())
}

pub fn verify_pda<const N: usize>(
    account: &AccountView,
    seeds: &[&[u8]; N],
    program_id: &[u8; 32],
) -> ProgramResult {
    let derived = pinocchio_pubkey::derive_address(seeds, None, program_id);
    if derived != *account.address().as_array() {
        return Err(pinocchio::error::ProgramError::InvalidAccountData);
    }
    Ok(())
}
