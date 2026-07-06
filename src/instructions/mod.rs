pub mod initialize;
pub mod initialize_tree_account_for_spl_token;
pub mod transact;
pub mod update_deposit_limit;
pub mod update_deposit_limit_for_spl;
pub mod update_global_config;

pub use initialize::*;
pub use initialize_tree_account_for_spl_token::*;
pub use transact::*;
pub use update_global_config::*;

use pinocchio::error::ProgramError;

pub enum PrivacyCashInstructions {
    Initialize = 0,
    InitializeTreeAccountForSplToken = 1,
    Transact = 2,
}

impl TryFrom<&u8> for PrivacyCashInstructions {
    type Error = ProgramError;

    fn try_from(value: &u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(PrivacyCashInstructions::Initialize),
            1 => Ok(PrivacyCashInstructions::InitializeTreeAccountForSplToken),
            2 => Ok(PrivacyCashInstructions::Transact),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
