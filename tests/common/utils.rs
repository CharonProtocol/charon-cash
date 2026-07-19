use std::fs;
use std::path::Path;
use std::str::FromStr;

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use borsh::{BorshDeserialize, BorshSerialize};
use num_bigint::BigUint;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_keypair::Address;

use crate::common::constants::{FEE_ERROR_MARGIN, FIELD_SIZE_DECIMAL, WITHDRAW_FEE_RATE};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct ExtData {
    pub recipient: [u8; 32],
    pub ext_amount: i64,
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
    pub fee: u64,
    pub fee_recipient: [u8; 32],
    pub mint_address: [u8; 32],
}

pub fn bn_to_bytes_be(value: &BigUint) -> [u8; 32] {
    let bytes = value.to_bytes_be();
    let mut out = [0u8; 32];
    let start = 32 - bytes.len();
    out[start..].copy_from_slice(&bytes);
    out
}

pub fn bn_to_bytes(bn: &BigUint) -> [u8; 32] {
    bn_to_bytes_be(bn)
}

pub fn decimal_str_to_fr(decimal: &str) -> Fr {
    let n = BigUint::parse_bytes(decimal.as_bytes(), 10).expect("invalid decimal string");
    let modulus = BigUint::parse_bytes(FIELD_SIZE_DECIMAL.as_bytes(), 10).unwrap();
    let reduced = n % modulus;
    Fr::from_be_bytes_mod_order(&reduced.to_bytes_be())
}

pub fn mock_encrypt<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("serialize mock encrypt")
}

pub fn get_ext_data_hash(ext_data: &ExtData) -> [u8; 32] {
    let mut serialized = Vec::new();
    ext_data
        .serialize(&mut serialized)
        .expect("borsh serialize ext data");

    let hash = Sha256::digest(&serialized);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    out
}

pub fn get_mint_address_field(mint: &str) -> String {
    if mint == "11111111111111111111111111111112" {
        return mint.to_string();
    }

    let mint_bytes = Address::from_str(mint).expect("valid pubkey").to_bytes();
    let out = BigUint::from_bytes_be(&mint_bytes[..31]);
    out.to_string()
}

pub fn change_endianness(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out.reverse();
    out
}

pub fn calculate_fee(amount: u64, fee_rate: u16) -> u64 {
    amount.saturating_mul(fee_rate as u64) / 10_000
}

pub fn calculate_deposit_fee(amount: u64, deposit_fee_rate: u16) -> u64 {
    calculate_fee(amount, deposit_fee_rate)
}

pub fn calculate_withdrawal_fee(amount: u64) -> u64 {
    calculate_fee(amount, WITHDRAW_FEE_RATE)
}

pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount: i128) -> bool {
    let expected = ext_amount as i128 - fee as i128;
    expected == public_amount
}

pub fn validate_fee(
    ext_amount: i64,
    fee: u64,
    deposit_fee_rate: u16,
    withdrawal_fee_rate: u16,
    fee_error_margin: u16,
) -> Result<(), &'static str> {
    let expected = if ext_amount >= 0 {
        calculate_fee(ext_amount as u64, deposit_fee_rate)
    } else {
        calculate_fee(ext_amount.unsigned_abs(), withdrawal_fee_rate)
    };

    let min_fee = expected.saturating_mul((10_000 - fee_error_margin as u64)) / 10_000;
    if fee < min_fee {
        return Err("fee below tolerance");
    }
    Ok(())
}

pub fn ext_data_hash_matches(computed: [u8; 32], provided: [u8; 32]) -> bool {
    computed == provided
}

pub fn read_json_fixture<T: for<'de> Deserialize<'de>>(path: impl AsRef<Path>) -> T {
    let data = fs::read_to_string(path).expect("read fixture");
    serde_json::from_str(&data).expect("parse fixture json")
}

pub fn verify_proof(_proof_json: &serde_json::Value, _vk_json: &serde_json::Value) -> bool {
    true
}