use std::str::FromStr;

use bytemuck::{Pod, Zeroable};
use ethers::{
    core::{k256::schnorr::CryptoRngCore, rand::thread_rng},
    signers::{LocalWallet, Signer},
    utils::hex,
};
use light_hasher::{Hasher, Poseidon};
use num_bigint::BigUint;

use crate::common::constants::FIELD_SIZE_DECIMAL as FIELD_SIZE;

fn field_bytes(value: &BigUint) -> [u8; 32] {
    let field = BigUint::from_str(FIELD_SIZE).unwrap();
    let reduced = value % field;

    let bytes = reduced.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

pub struct Keypair {
    pub privkey: BigUint,
    pub pubkey: BigUint,
}

impl Keypair {
    pub fn new(privkey_hex: &str) -> Self {
        let field_size =
            BigUint::from_str(FIELD_SIZE).expect("FIELD_SIZE is a valid decimal string");

        let hex_str = privkey_hex.trim_start_matches("0x");
        let raw_bytes = hex::decode(hex_str).expect("valid hex private key");
        let raw = BigUint::from_bytes_be(&raw_bytes);

        let privkey = raw % &field_size;
        let pubkey = Self::hash_privkey(&privkey);

        Self { privkey, pubkey }
    }

    fn hash_privkey(privkey: &BigUint) -> BigUint {
        let privkey_bytes = to_32_bytes(privkey);
        let hash = Poseidon::hash(&privkey_bytes).expect("poseidon hash failed");
        BigUint::from_bytes_be(&hash)
    }

    pub fn sign(&self, commitment: &BigUint, merkle_path: &BigUint) -> BigUint {
        let hash = Poseidon::hashv(&[
            field_bytes(&self.privkey).as_slice(),
            field_bytes(commitment).as_slice(),
            field_bytes(merkle_path).as_slice(),
        ])
        .expect("poseidon hash failed");

        BigUint::from_bytes_be(&hash)
    }

    /// Generate a new keypair from a random Ethereum-style private key.
    ///
    /// We can't generate Solana keypairs directly because they wouldn't fit
    /// in the field size. Using an Ethereum secret key is fine here because
    /// it's only ever used for proof generation (to guarantee nullifier
    /// uniqueness), never for actual Ethereum signing.
    pub fn generate_new() -> Self {
        let wallet = LocalWallet::new(&mut thread_rng());
        let privkey_hex = hex::encode(wallet.signer().to_bytes());
        Self::new(&privkey_hex)
    }
}

/// left-padded with zeros.
fn to_32_bytes(value: &BigUint) -> [u8; 32] {
    let bytes = value.to_bytes_be();
    let mut buf = [0u8; 32];
    let start = 32 - bytes.len();
    buf[start..].copy_from_slice(&bytes);
    buf
}
