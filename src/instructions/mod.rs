pub mod initialize;
pub mod initialize_tree_account_for_spl_token;

pub use initialize::*;
pub use initialize_tree_account_for_spl_token::*;
use pinocchio::error::ProgramError;

pub enum PrivacyCashInstructions {
    Initialize = 0,
    InitializeTreeAccountForSplToken = 1,
}

impl TryFrom<&u8> for PrivacyCashInstructions {
    type Error = ProgramError;

    fn try_from(value: &u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(PrivacyCashInstructions::Initialize),
            1 => Ok(PrivacyCashInstructions::InitializeTreeAccountForSplToken),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
