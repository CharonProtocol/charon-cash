use crate::{
    constants::{TREE_TOKEN_ACCOUNT_SEED, WSOL_MINT},
    error::PrivacyCashError,
    helper::{verify_pda, verify_program_id, verify_signer},
    state::TreeTokenAccount,
};
use bytemuck::try_from_bytes;
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_log::log;
use pinocchio_system::instructions::{Assign, Transfer};
use pinocchio_token::{instructions::SyncNative, state::TokenAccount};

/// Debit the SOL vault and wrap into the pool wSOL ATA.
///
/// Surfpool v1 drops `set_lamports` updates, so this instruction temporarily
/// makes the vault a zero-data System account, System-Transfers into wSOL,
/// then restores the vault PDA.
///
/// Accounts:
/// 0 sol_vault, 1 pool_wsol, 2 wsol_mint, 3 signer,
/// 4 token_program, 5 system_program.
#[inline(never)]
pub fn process_wrap_sol(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [sol_vault, pool_wsol, wsol_mint, signer, token_program, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    verify_signer(signer)?;
    verify_program_id(system_program, &pinocchio_system::ID)?;
    verify_program_id(token_program, &pinocchio_token::ID)?;
    if wsol_mint.address().as_array() != &WSOL_MINT {
        return Err(PrivacyCashError::InvalidMintAddress.into());
    }

    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = u64::from_le_bytes(
        data[..8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    if amount == 0 {
        return Err(PrivacyCashError::InvalidSwapAmount.into());
    }

    let mut saved = [0u8; TreeTokenAccount::LEN];
    let vault_bump = {
        let token_data = sol_vault.try_borrow()?;
        let token = try_from_bytes::<TreeTokenAccount>(&token_data[..TreeTokenAccount::LEN])
            .map_err(|_| ProgramError::InvalidAccountData)?;
        verify_pda(
            sol_vault,
            &[TREE_TOKEN_ACCOUNT_SEED, &[token.bump]],
            &crate::ID,
        )?;
        saved.copy_from_slice(&token_data[..TreeTokenAccount::LEN]);
        token.bump
    };

    let rent_exempt_minimum = Rent::get()?.try_minimum_balance(TreeTokenAccount::LEN)?;
    let required = amount
        .checked_add(rent_exempt_minimum)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if sol_vault.lamports() < required {
        return Err(PrivacyCashError::InsufficientFundsForWithdrawal.into());
    }

    {
        let token = TokenAccount::from_account_view(pool_wsol)?;
        if token.mint() != wsol_mint.address() {
            return Err(PrivacyCashError::InvalidTokenAccountMintAddress.into());
        }
    }

    {
        let mut token_data = sol_vault.try_borrow_mut()?;
        token_data[..TreeTokenAccount::LEN].fill(0);
    }
    sol_vault.resize(0)?;
    unsafe {
        sol_vault.assign(&pinocchio_system::ID);
    }
    log!("wrap_sol assigned");

    let vault_bump_seed = [vault_bump];
    let vault_seeds = [
        Seed::from(TREE_TOKEN_ACCOUNT_SEED),
        Seed::from(&vault_bump_seed),
    ];
    let vault_signer = [Signer::from(&vault_seeds)];
    Transfer {
        from: sol_vault,
        to: pool_wsol,
        lamports: amount,
    }
    .invoke_signed(&vault_signer)?;
    log!("wrap_sol transferred");

    let program_id = Address::from(crate::ID);
    Assign {
        account: sol_vault,
        owner: &program_id,
    }
    .invoke_signed(&vault_signer)?;
    sol_vault.resize(TreeTokenAccount::LEN)?;
    {
        let mut token_data = sol_vault.try_borrow_mut()?;
        token_data[..TreeTokenAccount::LEN].copy_from_slice(&saved);
    }

    SyncNative {
        native_token: pool_wsol,
    }
    .invoke()?;
    log!("wrap_sol done");

    Ok(())
}
