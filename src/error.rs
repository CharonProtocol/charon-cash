use pinocchio::error::ProgramError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrivacyCashError {
    Unauthorized = 0,
    InvalidMintAddress = 1,
    InvalidMerkleTreeHeight = 2,
    InvalidRootHistorySize = 3,
    InvalidFeeRate = 4,
}

impl From<PrivacyCashError> for ProgramError {
    fn from(e: PrivacyCashError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
