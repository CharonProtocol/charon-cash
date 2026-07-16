pub mod initialize;
pub mod initialize_tree_account_for_spl_token;
pub mod transact;
pub mod transact_spl;
pub mod update_deposit_limit;
pub mod update_deposit_limit_for_spl;
pub mod update_global_config;

pub use initialize::*;
pub use initialize_tree_account_for_spl_token::*;
pub use transact::*;
pub use transact_spl::*;
pub use update_deposit_limit::*;
pub use update_deposit_limit_for_spl::*;
pub use update_global_config::*;

use pinocchio::error::ProgramError;

/// The instruction discriminators live in `pc-types` so the indexer decodes against the same
/// values the program dispatches on. This alias keeps existing call sites unchanged.
pub use pc_types::PrivacyCashInstruction as PrivacyCashInstructions;

/// Adapter for the entrypoint, which hands us the discriminator by reference.
pub fn instruction_from_byte(value: &u8) -> Result<PrivacyCashInstructions, ProgramError> {
    PrivacyCashInstructions::from_u8(*value).ok_or(ProgramError::InvalidInstructionData)
}
