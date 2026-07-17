use light_hasher::{Hasher, Sha256};
use sha256::digest;
use solana_keypair::Address;

struct ExtData<'a> {
    recipient: &'a Address,
    ext_amount: u64,
    encrypted_output1: &'a str,
    encrypted_output2: &'a str,
    fee: u64,
    fee_recipient: &'a Address,
    mint_address: &'a Address,
}

pub fn get_ext_data_hash(ext_data: ExtData) {
    let mut data = Vec::new();

    data.extend_from_slice(ext_data.recipient.as_array());
    data.extend_from_slice(&ext_data.ext_amount.to_le_bytes());
    data.extend_from_slice(&(ext_data.encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(ext_data.encrypted_output1.as_bytes());
    data.extend_from_slice(&(ext_data.encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(ext_data.encrypted_output2.as_bytes());
    data.extend_from_slice(&ext_data.fee.to_le_bytes());
    data.extend_from_slice(ext_data.fee_recipient.as_array());
    data.extend_from_slice(ext_data.mint_address.as_array());

    Sha256::hash(&data).expect("Couldn't Hash the Ext Data");
}
