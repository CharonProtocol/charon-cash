use pinocchio::{entrypoint, error::ProgramError, AccountView, Address, ProgramResult};
use pinocchio_pubkey::declare_id;

use crate::instructions::{
    process_initialize, process_initialize_tree_account_for_spl_token, process_transact,
    process_transact_spl, process_update_global_config,
    update_deposit_limit::process_update_deposit_limit,
    update_deposit_limit_for_spl::process_update_deposit_limit_for_spl, PrivacyCashInstructions,
};

pub mod constants;
pub mod error;
pub mod field;
pub mod groth16;
pub mod helper;
pub mod instructions;
pub mod merkle_tree;
pub mod state;
pub mod utils;

declare_id!("HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV");

// The widest instruction, `transact_spl`, takes 16 accounts. Sizing the
// entrypoint's account array to that instead of the 255-slot default keeps the
// entrypoint stack frame an order of magnitude smaller.
//
// The allocator stays: `solana-bn254` allocates its result buffer inside every
// `alt_bn128` syscall wrapper, so `no_allocator!` would abort the program in
// `verify_proof`.
entrypoint!(process_instructions, 16);

fn process_instructions(
    _program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let (discriminator, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match PrivacyCashInstructions::try_from(discriminator)? {
        PrivacyCashInstructions::Initialize => process_initialize(accounts, data)?,
        PrivacyCashInstructions::InitializeTreeAccountForSplToken => {
            process_initialize_tree_account_for_spl_token(accounts, data)?
        }
        PrivacyCashInstructions::Transact => process_transact(accounts, data)?,
        PrivacyCashInstructions::TransactSpl => process_transact_spl(accounts, data)?,
        PrivacyCashInstructions::UpdateDepositLimit => {
            process_update_deposit_limit(accounts, data)?
        }
        PrivacyCashInstructions::UpdateDepositLimitForSpl => {
            process_update_deposit_limit_for_spl(accounts, data)?
        }
        PrivacyCashInstructions::UpdateGlobalConfig => {
            process_update_global_config(accounts, data)?
        }
    }
    Ok(())
}
