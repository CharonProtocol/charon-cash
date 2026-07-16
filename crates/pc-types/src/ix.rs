//! Instruction discriminators.
//!
//! These were previously declared twice: once as an enum in the program, and once as bare
//! literals in the indexer's decoder. Both sides now name the same values.

/// Leading byte of every instruction's data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PrivacyCashInstruction {
    Initialize = 0,
    InitializeTreeAccountForSplToken = 1,
    Transact = 2,
    TransactSpl = 3,
    UpdateGlobalConfig = 4,
    UpdateDepositLimit = 5,
    UpdateDepositLimitForSpl = 6,
}

impl PrivacyCashInstruction {
    pub const fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(Self::Initialize),
            1 => Some(Self::InitializeTreeAccountForSplToken),
            2 => Some(Self::Transact),
            3 => Some(Self::TransactSpl),
            4 => Some(Self::UpdateGlobalConfig),
            5 => Some(Self::UpdateDepositLimit),
            6 => Some(Self::UpdateDepositLimitForSpl),
            _ => None,
        }
    }

    /// True for the two instructions that append leaves and emit a [`crate::CommitmentEvent`].
    pub const fn appends_leaves(&self) -> bool {
        matches!(self, Self::Transact | Self::TransactSpl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_are_stable() {
        // The indexer decodes live instruction data against these. Changing a value is a
        // wire-breaking change, so pin them explicitly rather than trusting declaration order.
        assert_eq!(PrivacyCashInstruction::Transact as u8, 2);
        assert_eq!(PrivacyCashInstruction::TransactSpl as u8, 3);
    }

    #[test]
    fn only_transact_appends_leaves() {
        assert!(PrivacyCashInstruction::Transact.appends_leaves());
        assert!(PrivacyCashInstruction::TransactSpl.appends_leaves());
        assert!(!PrivacyCashInstruction::Initialize.appends_leaves());
        assert!(!PrivacyCashInstruction::UpdateGlobalConfig.appends_leaves());
    }

    #[test]
    fn unknown_discriminator_is_none() {
        assert_eq!(PrivacyCashInstruction::from_u8(7), None);
        assert_eq!(PrivacyCashInstruction::from_u8(255), None);
    }
}
