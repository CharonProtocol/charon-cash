use ark_bn254::Fr;
use ark_ff::PrimeField;
use crate::error::PrivacyCashError;
use light_hasher::{Hasher, Sha256};
use pinocchio::error::ProgramError;

pub fn validate_fee(
    ext_amount: i64,
    provided_fee: u64,
    deposit_fee_rate: u16,
    withdrawal_fee_rate: u16,
    fee_error_margin: u16,
) -> Result<(), ProgramError> {
    if ext_amount == 0 {
        return Ok(());
    }

    let fee_rate = if ext_amount > 0 {
        deposit_fee_rate
    } else {
        withdrawal_fee_rate
    };

    let amount_abs = if ext_amount > 0 {
        ext_amount as u64
    } else {
        (-ext_amount) as u64
    };

    let expected_fee = amount_abs
        .checked_mul(fee_rate as u64)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let min_acceptable_fee = expected_fee
        .checked_mul((10_000u64).saturating_sub(fee_error_margin as u64))
        .and_then(|v| v.checked_div(10_000))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if provided_fee < min_acceptable_fee {
        return Err(PrivacyCashError::InvalidFeeAmount.into());
    }

    Ok(())
}

pub fn calculate_complete_ext_data_hash(
    recipient: [u8; 32],
    ext_amount: i64,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    fee: u64,
    fee_recipient: [u8; 32],
    mint_address: [u8; 32],
) -> Result<[u8; 32], ProgramError> {
    let mut data = Vec::new();

    data.extend_from_slice(&recipient);
    data.extend_from_slice(&ext_amount.to_le_bytes());
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);
    data.extend_from_slice(&fee.to_le_bytes());
    data.extend_from_slice(&fee_recipient);
    data.extend_from_slice(&mint_address);

    Sha256::hash(&data).map_err(|_| ProgramError::InvalidInstructionData)
}

pub fn ext_data_hash_matches(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
    Fr::from_le_bytes_mod_order(&calculated) == Fr::from_be_bytes_mod_order(&proof_hash)
}

pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
    if ext_amount == i64::MIN {
        return false;
    }

    let fee_fr = Fr::from(fee);
    let ext_amount_fr = if ext_amount >= 0 {
        Fr::from(ext_amount as u64)
    } else {
        let abs_ext_amount = match ext_amount.checked_neg() {
            Some(val) => val,
            None => return false,
        };
        Fr::from(abs_ext_amount as u64)
    };

    if ext_amount >= 0 && ext_amount_fr <= fee_fr {
        return false;
    }

    let result_public_amount = if ext_amount >= 0 {
        ext_amount_fr - fee_fr
    } else {
        -(ext_amount_fr + fee_fr)
    };

    let provided_amount = Fr::from_be_bytes_mod_order(&public_amount_bytes);
    result_public_amount == provided_amount
}
