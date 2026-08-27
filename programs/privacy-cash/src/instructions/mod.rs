pub mod initialize;
pub mod initialize_tree_account_for_spl_token;
pub mod transact;
pub mod transact_batch3;
pub mod transact_spl;
pub mod update_deposit_limit;
pub mod update_deposit_limit_for_spl;
pub mod update_global_config;

pub use initialize::*;
pub use initialize_tree_account_for_spl_token::*;
pub use transact::*;
pub use transact_batch3::*;
pub use transact_spl::*;
pub use update_global_config::*;

use pinocchio::error::ProgramError;

pub enum PrivacyCashInstructions {
    Initialize = 0,
    InitializeTreeAccountForSplToken = 1,
    Transact = 2,
    TransactSpl = 3,
    UpdateDepositLimit = 4,
    UpdateDepositLimitForSpl = 5,
    UpdateGlobalConfig = 6,
    TransactBatch3 = 7,
}

impl TryFrom<&u8> for PrivacyCashInstructions {
    type Error = ProgramError;

    fn try_from(value: &u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(PrivacyCashInstructions::Initialize),
            1 => Ok(PrivacyCashInstructions::InitializeTreeAccountForSplToken),
            2 => Ok(PrivacyCashInstructions::Transact),
            3 => Ok(PrivacyCashInstructions::TransactSpl),
            4 => Ok(PrivacyCashInstructions::UpdateDepositLimit),
            5 => Ok(PrivacyCashInstructions::UpdateDepositLimitForSpl),
            6 => Ok(PrivacyCashInstructions::UpdateGlobalConfig),
            7 => Ok(PrivacyCashInstructions::TransactBatch3),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}
