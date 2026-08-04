use crate::relayer::dto::TransactInput;

pub const DISC_INITIALIZE: u8 = 0;
pub const DISC_INITIALIZE_SPL: u8 = 1;
pub const DISC_TRANSACT: u8 = 2;
pub const DISC_TRANSACT_SPL: u8 = 3;
pub const DISC_UPDATE_DEPOSIT_LIMIT: u8 = 4;
pub const DISC_UPDATE_DEPOSIT_LIMIT_SPL: u8 = 5;
pub const DISC_UPDATE_GLOBAL_CONFIG: u8 = 6;

pub fn transact_data(disc: u8, t: &TransactInput, nullifier_bump0: u8, nullifier_bump1: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(1 + 480 + 16 + 8 + t.encrypted_output1.len() + t.encrypted_output2.len() + 2);
    data.push(disc);
    data.extend_from_slice(&t.proof_a);
    data.extend_from_slice(&t.proof_b);
    data.extend_from_slice(&t.proof_c);
    data.extend_from_slice(&t.root);
    data.extend_from_slice(&t.public_amount);
    data.extend_from_slice(&t.ext_data_hash);
    data.extend_from_slice(&t.input_nullifiers[0]);
    data.extend_from_slice(&t.input_nullifiers[1]);
    data.extend_from_slice(&t.output_commitments[0]);
    data.extend_from_slice(&t.output_commitments[1]);
    data.extend_from_slice(&t.ext_amount.to_le_bytes());
    data.extend_from_slice(&t.fee.to_le_bytes());
    data.extend_from_slice(&(t.encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(&t.encrypted_output1);
    data.extend_from_slice(&(t.encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(&t.encrypted_output2);
    data.push(nullifier_bump0);
    data.push(nullifier_bump1);
    data
}

pub fn initialize_data(tree_account_bump: u8, tree_token_account_bump: u8, global_config_bump: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(4);
    data.push(DISC_INITIALIZE);
    data.push(tree_account_bump);
    data.push(tree_token_account_bump);
    data.push(global_config_bump);
    data
}

pub fn initialize_spl_data(max_deposit_amount: u64, tree_account_bump: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(17);
    data.push(DISC_INITIALIZE_SPL);
    data.extend_from_slice(&max_deposit_amount.to_le_bytes());
    data.push(tree_account_bump);
    data.extend_from_slice(&[0u8; 7]);
    data
}

pub fn update_global_config_data(
    deposit_fee_rate: u16,
    withdrawal_fee_rate: u16,
    fee_error_margin: u16,
    update_mask: u8,
) -> Vec<u8> {
    let mut data = Vec::with_capacity(9);
    data.push(DISC_UPDATE_GLOBAL_CONFIG);
    data.extend_from_slice(&deposit_fee_rate.to_le_bytes());
    data.extend_from_slice(&withdrawal_fee_rate.to_le_bytes());
    data.extend_from_slice(&fee_error_margin.to_le_bytes());
    data.push(update_mask);
    data.push(0);
    data
}

pub fn update_deposit_limit_data(new_limit: u64, tree_account_bump: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(10);
    data.push(DISC_UPDATE_DEPOSIT_LIMIT);
    data.extend_from_slice(&new_limit.to_le_bytes());
    data.push(tree_account_bump);
    data
}

pub fn update_deposit_limit_spl_data(new_limit: u64, tree_account_bump: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(10);
    data.push(DISC_UPDATE_DEPOSIT_LIMIT_SPL);
    data.extend_from_slice(&new_limit.to_le_bytes());
    data.push(tree_account_bump);
    data
}
