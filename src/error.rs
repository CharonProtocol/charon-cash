use pinocchio::error::ProgramError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrivacyCashError {
    Unauthorized = 0,
    InvalidMintAddress = 1,
    InvalidMerkleTreeHeight = 2,
    InvalidRootHistorySize = 3,
    InvalidFeeRate = 4,
    UnknownRoot = 5,
    ExtDataHashMismatch = 6,
    InvalidPublicAmountData = 7,
    DepositLimitExceeded = 8,
    InsufficientFundsForWithdrawal = 9,
    InsufficientFundsForFee = 10,
    InvalidFeeAmount = 11,
    InvalidTokenAccount = 12,
    InvalidTokenAccountMintAddress = 13,
}

impl From<PrivacyCashError> for ProgramError {
    fn from(e: PrivacyCashError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
