use crate::state::NullifierAccount;
use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::rent::Rent,
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

/// Only the canonical (highest valid) bump may mark a nullifier spent: every
/// other valid bump derives a different PDA for the same nullifier, which
/// would let the same note be spent once per bump.
fn verify_canonical_bump(seeds: &[&[u8]; 2], bump: u8) -> ProgramResult {
    #[cfg(target_os = "solana")]
    for higher in (bump as u16 + 1)..=u8::MAX as u16 {
        let b = [higher as u8];
        if Address::create_program_address(&[seeds[0], seeds[1], &b], &Address::from(crate::ID)).is_ok() {
            return Err(ProgramError::InvalidSeeds);
        }
    }
    #[cfg(not(target_os = "solana"))]
    let _ = (seeds, bump);
    Ok(())
}

pub fn init_nullifier_account(
    payer: &AccountView,
    nullifier_account: &AccountView,
    seed_prefix: &[u8],
    nullifier_hash: &[u8; 32],
    bump: u8,
    rent: &Rent,
) -> ProgramResult {
    verify_uninitialized(nullifier_account)?;

    let bump_seed = [bump];
    // `CreateAccount` also accepts a transaction signer. Without this
    // derivation a caller can pass a keypair they control and leave the real
    // nullifier PDA unclaimed.
    verify_pda(
        nullifier_account,
        &[seed_prefix, nullifier_hash, &bump_seed],
        &crate::ID,
    )?;
    verify_canonical_bump(&[seed_prefix, nullifier_hash], bump)?;

    let space = core::mem::size_of::<NullifierAccount>();
    let lamports = rent.try_minimum_balance(space)?;

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

/// Anchor-style event discriminators: sha256("event:<Name>")[..8].
pub const TRANSACT_EVENT: [u8; 8] = [89, 245, 87, 250, 222, 30, 135, 142];
pub const TRANSACT_SPL_EVENT: [u8; 8] = [184, 148, 174, 250, 197, 131, 248, 136];

/// Emit a pool append as one Anchor-style event (a single `Program data:`
/// field: discriminator + Borsh body) so an indexer reads the new leaves from
/// the logs subscription instead of fetching the tx, and explorers list it
/// under Events. Every field is already public in the instruction data.
/// Body: first_leaf_index u32, [mint [u8; 32] for SPL pools], commitments
/// [[u8; 32]; 2], nullifiers [[u8; 32]; 2], encrypted_output1 Vec<u8>,
/// encrypted_output2 Vec<u8>.
pub fn emit_transact_event(
    first_leaf_index: u32,
    mint: Option<&[u8; 32]>,
    commitments: &[[u8; 32]; 2],
    nullifiers: &[[u8; 32]; 2],
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
) {
    let mut data = Vec::with_capacity(8 + 4 + 32 + 128 + 8 + encrypted_output1.len() + encrypted_output2.len());
    data.extend_from_slice(if mint.is_some() { &TRANSACT_SPL_EVENT } else { &TRANSACT_EVENT });
    data.extend_from_slice(&first_leaf_index.to_le_bytes());
    if let Some(m) = mint {
        data.extend_from_slice(m);
    }
    data.extend_from_slice(bytemuck::cast_slice(commitments));
    data.extend_from_slice(bytemuck::cast_slice(nullifiers));
    for enc in [encrypted_output1, encrypted_output2] {
        data.extend_from_slice(&(enc.len() as u32).to_le_bytes());
        data.extend_from_slice(enc);
    }
    let fields: [&[u8]; 1] = [&data];
    #[cfg(target_os = "solana")]
    // SAFETY: `fields` is a valid slice of byte slices for the syscall's duration.
    unsafe {
        pinocchio::syscalls::sol_log_data(fields.as_ptr() as *const u8, fields.len() as u64)
    };
    #[cfg(not(target_os = "solana"))]
    let _ = fields;
}
