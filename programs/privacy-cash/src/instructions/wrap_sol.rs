use crate::{
    constants::{GLOBAL_CONFIG_ADDRESS, TREE_ACCOUNT_ADDRESS, TREE_TOKEN_ACCOUNT_ADDRESS, WSOL_MINT},
    error::PrivacyCashError,
    helper::{verify_address, verify_program_id, verify_signer},
    state::TreeTokenAccount,
};
use pinocchio::{
    error::ProgramError,
    sysvars::{instructions::Instructions, rent::Rent, Sysvar},
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
/// Only as the first step of a SOL -> SPL swap: the next instruction must be
/// Token `SyncNative` on this wSOL account and the one after it this
/// program's Swap spending exactly `amount` from the SOL tree. A standalone
/// wrap (or a wrap bigger than its swap) is rejected, so vault SOL can only
/// move into wSOL for a swap whose proof released it. The wrap must be a
/// top-level instruction (no CPI: the transaction's current instruction is
/// this exact WrapSol), and the swap's pool wSOL must be this wSOL account.
///
/// Accounts:
/// 0 sol_vault, 1 pool_wsol, 2 wsol_mint, 3 signer,
/// 4 token_program, 5 system_program, 6 instructions sysvar.
#[inline(never)]
pub fn process_wrap_sol(accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let [sol_vault, pool_wsol, wsol_mint, signer, token_program, system_program, instructions] = accounts else {
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
    verify_paired_swap(instructions, pool_wsol, &data[..8], amount)?;

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

/// Swap data: discriminator, proof_in (352), proof_out (352), ext_amount_in.
const SWAP_DISCRIMINATOR: u8 = 7;
const SWAP_EXT_AMOUNT_IN_OFFSET: usize = 1 + 352 + 352;
/// Swap account 9 = pool wSOL.
const SWAP_POOL_WSOL_INDEX: usize = 9;
const WRAP_SOL_DISCRIMINATOR: u8 = 8;
/// Token program SyncNative.
const SYNC_NATIVE_DISCRIMINATOR: u8 = 17;

fn verify_paired_swap(
    instructions: &AccountView,
    pool_wsol: &AccountView,
    amount_bytes: &[u8],
    amount: u64,
) -> ProgramResult {
    let ixs = Instructions::try_from(instructions)?;
    let bad = || ProgramError::from(PrivacyCashError::InvalidSwapAmount);

    // Relative lookups index the top-level instruction; a CPI'd wrap would
    // borrow another instruction's neighbours. Our program never CPIs
    // itself, so the top-level instruction must be this WrapSol.
    let current = ixs.get_instruction_relative(0).map_err(|_| bad())?;
    let current_data = current.get_instruction_data();
    if current.get_program_id().as_array() != &crate::ID
        || current_data.first() != Some(&WRAP_SOL_DISCRIMINATOR)
        || current_data.get(1..9) != Some(amount_bytes)
        || &current.get_instruction_account_at(1)?.key != pool_wsol.address()
    {
        return Err(bad());
    }

    let sync = ixs.get_instruction_relative(1).map_err(|_| bad())?;
    if sync.get_program_id() != &pinocchio_token::ID
        || sync.get_instruction_data() != [SYNC_NATIVE_DISCRIMINATOR]
        || &sync.get_instruction_account_at(0)?.key != pool_wsol.address()
    {
        return Err(bad());
    }

    let swap = ixs.get_instruction_relative(2).map_err(|_| bad())?;
    let data = swap.get_instruction_data();
    if swap.get_program_id().as_array() != &crate::ID
        || data.first() != Some(&SWAP_DISCRIMINATOR)
        || data.len() < SWAP_EXT_AMOUNT_IN_OFFSET + 8
    {
        return Err(bad());
    }
    // SOL -> SPL only: the swap spends from the SOL tree
    if swap.get_instruction_account_at(0)?.key.as_array() != &TREE_ACCOUNT_ADDRESS
        || &swap.get_instruction_account_at(SWAP_POOL_WSOL_INDEX)?.key != pool_wsol.address()
    {
        return Err(bad());
    }
    let ext_in = i64::from_le_bytes(
        data[SWAP_EXT_AMOUNT_IN_OFFSET..SWAP_EXT_AMOUNT_IN_OFFSET + 8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    if ext_in.checked_neg() != Some(amount as i64) || amount > i64::MAX as u64 {
        return Err(bad());
    }
    Ok(())
}
