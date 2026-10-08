use crate::{
    constants::{GLOBAL_CONFIG_ADDRESS, TREE_TOKEN_ACCOUNT_ADDRESS, WSOL_MINT},
    error::PrivacyCashError,
    helper::{verify_address, verify_program_id, verify_signer},
    state::TreeTokenAccount,
};
use pinocchio::{
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    AccountView, ProgramResult,
};
use pinocchio_log::log;
use pinocchio_token::state::TokenAccount;

/// Debit the SOL vault into the pool wSOL ATA (Transact-style `set_lamports`).
///
/// Do not CPI Token (`SyncNative`) in this instruction. Pinocchio lamport
/// writes are not visible to a CPI's TransactionContext snapshot; Token
/// then copies the stale lamports back and the instruction is
/// `UnbalancedInstruction`. A later instruction (Token `SyncNative`, then
/// Swap) runs after this commit so Jupiter sees the token amount.
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
    if !sol_vault.is_writable() || !pool_wsol.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
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

    verify_address(sol_vault, &TREE_TOKEN_ACCOUNT_ADDRESS)?;

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
        // Owner is compared from the raw token-account bytes. A field compare
        // against a compile-time constant is deleted by SBF LLVM because
        // `from_account_view` transmutes the buffer (owner is undef).
        let data = pool_wsol.try_borrow()?;
        let owner: &[u8; 32] = data[32..64]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        if owner != &GLOBAL_CONFIG_ADDRESS {
            return Err(PrivacyCashError::InvalidTokenAccount.into());
        }
    }

    let vault_after = sol_vault
        .lamports()
        .checked_sub(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let wsol_after = pool_wsol
        .lamports()
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    sol_vault.set_lamports(vault_after);
    pool_wsol.set_lamports(wsol_after);
    log!("wrap_sol done");

    Ok(())
}
