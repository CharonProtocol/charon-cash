use std::str::FromStr;

use light_hasher::{Hash, Hasher, HasherError, Poseidon};
use num_bigint::BigUint;
use num_traits::ToBytes;
use rand::random;
use solana_keypair::Address;
use crate::common::utils::get_mint_address_field;
use crate::common::keypair::Keypair;
use crate::common::constants::FIELD_SIZE_DECIMAL;

const DEFAULT_MINT_ADDRESS: &str = "11111111111111111111111111111112";

fn field_bytes(value: &BigUint) -> [u8; 32] {
    let field = BigUint::from_str(FIELD_SIZE_DECIMAL).unwrap();
    let reduced = value % field;

    let bytes = reduced.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

pub struct Utxo {
    pub amount: u64,
    pub blinding: u64,
    pub keypair: Keypair,
    pub index: u64,
    pub mint_address: Address,
}

impl Utxo {
    pub fn empty() -> Self {
    Self::new(0)
    }

    pub fn new(amount: u64) -> Self {
        Self::new_with_mint(amount, default_mint_address())
    }

    pub fn with_mint(amount: u64, mint_address: Address) -> Self {
        Self::new_with_mint(amount, mint_address)
    }

    pub fn new_with_index(amount: u64, index: u64) -> Self {
        Self {
            amount,
            blinding: random::<u64>(),
            keypair: Keypair::generate_new(),
            index,
            mint_address: default_mint_address(),
        }
    }

    pub fn new_full(
        amount: u64,
        blinding: u64,
        keypair: Keypair,
        index: u64,
        mint_address: Address,
    ) -> Self {
        Self {
            amount,
            blinding,
            keypair,
            index,
            mint_address,
        }
    }

    pub fn new_with_mint(amount: u64, mint_address: Address) -> Self {
        Self {
            amount,
            blinding: random::<u64>(),
            keypair: Keypair::generate_new(),
            index: 0,
            mint_address,
        }
    }

    pub fn with_amount(mut self, amount: u64) -> Self {
        self.amount = amount;
        self
    }

    pub fn with_blinding(mut self, blinding: u64) -> Self {
        self.blinding = blinding;
        self
    }

    pub fn with_keypair(mut self, keypair: Keypair) -> Self {
        self.keypair = keypair;
        self
    }

    pub fn with_index(mut self, index: u64) -> Self {
        self.index = index;
        self
    }

    pub fn with_mint_address(mut self, mint_address: Address) -> Self {
        self.mint_address = mint_address;
        self
    }

    pub fn get_commitment(&self) -> Result<Hash, HasherError> {
        let amount = BigUint::from(self.amount);
        let pubkey = self.keypair.pubkey.clone();
        let blinding = BigUint::from(self.blinding);
        let mint_field_str = get_mint_address_field(&self.mint_address.to_string());
        let mint = BigUint::from_str(&mint_field_str).unwrap();

        Poseidon::hashv(&[
            field_bytes(&amount).as_slice(),
            field_bytes(&pubkey).as_slice(),
            field_bytes(&blinding).as_slice(),
            field_bytes(&mint).as_slice(),
        ])
    }

    pub fn get_nullifier(&self) -> Result<Hash, HasherError> {
        let commitment = self.get_commitment()?;
        let commitment_field = BigUint::from_bytes_be(&commitment);
        let index = BigUint::from(self.index);

        let signature = self.keypair.sign(&commitment_field, &index);

        Poseidon::hashv(&[
            field_bytes(&commitment_field).as_slice(),
            field_bytes(&index).as_slice(),
            field_bytes(&signature).as_slice(),
        ])
    }

}

impl Default for Utxo {
    fn default() -> Self {
        Self::empty()
    }
}

fn default_mint_address() -> Address {
    Address::from_str(DEFAULT_MINT_ADDRESS).expect("invalid default mint address")
}