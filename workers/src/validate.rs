use ark_bn254::Fr;
use ark_ff::PrimeField;
use light_hasher::{Hasher, Sha256};

use crate::dto::TransactInput;
use crate::error::{AppError, AppResult};

pub fn assert_is_withdraw(t: &TransactInput) -> AppResult<()> {
    if t.ext_amount >= 0 {
        return Err(AppError::bad_request(
            "DEPOSIT_UNSUPPORTED",
            "relayer only handles withdrawals (ext_amount must be negative). \
             deposits require the depositor's own signature and cannot be relayed.",
        ));
    }
    Ok(())
}

pub fn ext_data_hash_matches(
    t: &TransactInput,
    fee_recipient: &[u8; 32],
    mint_address: &[u8; 32],
) -> AppResult<()> {
    let mut data = Vec::with_capacity(
        32 + 8 + 4 + t.encrypted_output1.len() + 4 + t.encrypted_output2.len() + 8 + 32 + 32,
    );
    data.extend_from_slice(&t.recipient.to_bytes());
    data.extend_from_slice(&t.ext_amount.to_le_bytes());
    data.extend_from_slice(&(t.encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(&t.encrypted_output1);
    data.extend_from_slice(&(t.encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(&t.encrypted_output2);
    data.extend_from_slice(&t.fee.to_le_bytes());
    data.extend_from_slice(fee_recipient);
    data.extend_from_slice(mint_address);

    let calculated = Sha256::hash(&data).map_err(|e| AppError::internal(e.to_string()))?;
    let left = Fr::from_le_bytes_mod_order(&calculated);
    let right = Fr::from_be_bytes_mod_order(&t.ext_data_hash);
    if left != right {
        return Err(AppError::bad_request(
            "EXT_DATA_HASH_MISMATCH",
            "recomputed ext_data_hash does not match the proof (recipient / fee_recipient / \
             fee / encrypted outputs / mint do not line up with what the proof committed to)",
        ));
    }
    Ok(())
}

pub fn public_amount_ok(t: &TransactInput) -> AppResult<()> {
    if t.ext_amount == i64::MIN {
        return Err(AppError::bad_request("INVALID_PUBLIC_AMOUNT", "ext_amount is i64::MIN"));
    }
    let fee_fr = Fr::from(t.fee);
    let ext_amount_fr = if t.ext_amount >= 0 {
        Fr::from(t.ext_amount as u64)
    } else {
        Fr::from((-(t.ext_amount)) as u64)
    };
    if t.ext_amount >= 0 && ext_amount_fr <= fee_fr {
        return Err(AppError::bad_request("INVALID_PUBLIC_AMOUNT", "ext_amount <= fee for deposit"));
    }
    let result = if t.ext_amount >= 0 {
        ext_amount_fr - fee_fr
    } else {
        -(ext_amount_fr + fee_fr)
    };
    let provided = Fr::from_be_bytes_mod_order(&t.public_amount);
    if result != provided {
        return Err(AppError::bad_request(
            "PUBLIC_AMOUNT_MISMATCH",
            "public_amount does not match ext_amount and fee",
        ));
    }
    Ok(())
}

pub fn min_withdraw_fee(ext_amount: i64, withdrawal_fee_rate_bps: u16, fee_error_margin_bps: u16) -> u64 {
    if ext_amount >= 0 {
        return 0;
    }
    let amount_abs = (-ext_amount) as u64;
    let expected_fee = amount_abs
        .saturating_mul(withdrawal_fee_rate_bps as u64)
        / 10_000;
    expected_fee
        .saturating_mul(10_000u64.saturating_sub(fee_error_margin_bps as u64))
        / 10_000
}

pub fn check_fee(
    t: &TransactInput,
    withdrawal_fee_rate_bps: u16,
    fee_error_margin_bps: u16,
) -> AppResult<()> {
    let min = min_withdraw_fee(t.ext_amount, withdrawal_fee_rate_bps, fee_error_margin_bps);
    if t.fee < min {
        return Err(AppError::bad_request(
            "FEE_TOO_LOW",
            format!("fee {} is below the on-chain minimum {min}", t.fee),
        ));
    }
    Ok(())
}
