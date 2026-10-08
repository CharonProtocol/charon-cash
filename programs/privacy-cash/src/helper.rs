use crate::state::NullifierAccount;
use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::PrivacyCashError;

pub fn verify_signer(account: &AccountView) -> ProgramResult {
    if !account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

pub fn verify_uninitialized(account: &AccountView) -> ProgramResult {
    if !account.is_data_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    Ok(())
}

pub fn verify_initialized(account: &AccountView) -> ProgramResult {
    if account.is_data_empty() {
        return Err(ProgramError::UninitializedAccount);
    }
    Ok(())
}

pub fn verify_program_id(account: &AccountView, expected: &pinocchio::Address) -> ProgramResult {
    if account.address() != expected {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

pub fn verify_authority(expected: &[u8; 32], authority: &AccountView) -> ProgramResult {
    if authority.address().as_array() != expected {
        return Err(PrivacyCashError::Unauthorized.into());
    }
    Ok(())
}

pub fn verify_basis_points(rate: u16) -> ProgramResult {
    if rate > 10_000 {
        return Err(PrivacyCashError::InvalidFeeRate.into());
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
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Checks an account against a compile-time address.
///
/// Used for the program's singleton PDAs, whose seeds have no runtime
/// component and whose addresses are therefore constants. See
/// `constants::TREE_ACCOUNT_ADDRESS` and friends.
pub fn verify_address(account: &AccountView, expected: &[u8; 32]) -> ProgramResult {
    if account.address().as_array() != expected {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn verify_cross_nullifier(account: &AccountView) -> ProgramResult {
    if account.owned_by(&Address::from(crate::ID)) && !account.is_data_empty() {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(())
}

pub fn init_nullifier_account(
    payer: &AccountView,
    nullifier_account: &AccountView,
    seed_prefix: &[u8],
    nullifier_hash: &[u8; 32],
    bump: u8,
) -> ProgramResult {
    verify_uninitialized(nullifier_account)?;

    let bump_seed = [bump];
    verify_pda(
        nullifier_account,
        &[seed_prefix, nullifier_hash, &bump_seed],
        &crate::ID,
    )?;

    let space = core::mem::size_of::<NullifierAccount>();
    let lamports = Rent::get()?.try_minimum_balance(space)?;

    let seeds = [
        Seed::from(seed_prefix),
        Seed::from(nullifier_hash.as_ref()),
        Seed::from(&bump_seed),
    ];
    let nullifier_signer = Signer::from(&seeds);

    CreateAccount {
        from: payer,
        to: nullifier_account,
        lamports,
        space: space as u64,
        owner: &Address::from(crate::ID),
    }
    .invoke_signed(&[nullifier_signer])?;

    let mut data = nullifier_account.try_borrow_mut()?;
    data[0] = bump;

    Ok(())
}
