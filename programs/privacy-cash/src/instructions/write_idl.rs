use crate::{
    constants::GLOBAL_CONFIG_ADDRESS,
    error::PrivacyCashError,
    helper::{verify_address, verify_authority, verify_initialized, verify_pda, verify_program_id, verify_signer},
    state::GlobalConfig,
};
use bytemuck::try_from_bytes;
use light_hasher::{Hasher, Sha256};
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccountWithSeed;

/// Anchor's IDL account: `create_with_seed(base, "anchor:idl", program)`, where
/// `base` is the program's no-seed PDA. Explorers read the program's IDL here.
const IDL_SEED: &str = "anchor:idl";
/// sha256("account:IdlAccount")[..8]
const IDL_ACCOUNT_DISCRIMINATOR: [u8; 8] = [140, 36, 166, 2, 103, 197, 33, 164];
/// discriminator + authority + data length
const IDL_HEADER_LEN: usize = 8 + 32 + 4;

/// Instruction 9 (admin only): create the program's Anchor IDL account if
/// needed and write one chunk of the zlib-compressed IDL into it. Data:
/// base_bump u8, capacity u32, total_len u32, offset u32, chunk bytes. The IDL
/// is only explorer metadata; this writes nowhere else.
pub fn process_write_idl(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [idl_account, base, global_config, authority, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(authority)?;
    verify_program_id(system_program, &pinocchio_system::ID)?;
    verify_initialized(global_config)?;
    verify_address(global_config, &GLOBAL_CONFIG_ADDRESS)?;
    {
        let global_data = global_config.try_borrow()?;
        let global = try_from_bytes::<GlobalConfig>(&global_data[..GlobalConfig::LEN])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        verify_authority(&global.authority, authority)?;
    }

    if data.len() < 13 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let base_bump = data[0];
    let u32_at = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]) as usize;
    let (capacity, total_len, offset) = (u32_at(1), u32_at(5), u32_at(9));
    let chunk = &data[13..];

    let bump_seed = [base_bump];
    verify_pda(base, &[&bump_seed], &crate::ID)?;
    let idl_address = Sha256::hashv(&[base.address().as_ref(), IDL_SEED.as_bytes(), &crate::ID])
        .map_err(|_| ProgramError::InvalidSeeds)?;
    if *idl_account.address().as_array() != idl_address {
        return Err(ProgramError::InvalidSeeds);
    }

    if idl_account.lamports() == 0 {
        if total_len > capacity {
            return Err(ProgramError::InvalidInstructionData);
        }
        let space = IDL_HEADER_LEN + capacity;
        let seeds = [Seed::from(&bump_seed)];
        CreateAccountWithSeed {
            from: authority,
            to: idl_account,
            base: Some(base),
            seed: IDL_SEED,
            lamports: Rent::get()?.try_minimum_balance(space)?,
            space: space as u64,
            owner: &Address::from(crate::ID),
        }
        .invoke_signed(&[Signer::from(&seeds)])?;
    } else if !idl_account.owned_by(&Address::from(crate::ID)) {
        return Err(PrivacyCashError::Unauthorized.into());
    }

    let mut account_data = idl_account.try_borrow_mut()?;
    let end = IDL_HEADER_LEN
        .checked_add(offset)
        .and_then(|x| x.checked_add(chunk.len()))
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if IDL_HEADER_LEN + total_len > account_data.len() || end > IDL_HEADER_LEN + total_len {
        return Err(ProgramError::AccountDataTooSmall);
    }
    account_data[..8].copy_from_slice(&IDL_ACCOUNT_DISCRIMINATOR);
    account_data[8..40].copy_from_slice(authority.address().as_ref());
    account_data[40..44].copy_from_slice(&(total_len as u32).to_le_bytes());
    account_data[IDL_HEADER_LEN + offset..end].copy_from_slice(chunk);
    Ok(())
}
