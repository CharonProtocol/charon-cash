use std::str::FromStr;

use bytemuck::{Pod, Zeroable};
use light_hasher::{Hash, Hasher, HasherError};
use num_bigint::BigUint;
use solana_keypair::Address;

use crate::common::keypair::Keypair;

pub struct Utxo {
    amount: u64,
    blinding: u64,
    keypair: Keypair,
    index: u64,
    mint_address: Address,
}

impl Utxo {
    fn new(
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

    fn get_commitment(&self) -> Result<Hash, HasherError> {
        let commitment_vec: Vec<u8> = [
            self.amount.to_le_bytes().as_slice(),
            self.keypair.pubkey.to_bytes_le().as_slice(),
            self.blinding.to_le_bytes().as_slice(),
            self.mint_address.as_array().as_slice(),
        ]
        .concat();
        light_hasher::Poseidon::hash(&commitment_vec)
    }
    fn get_nullifier(&self) -> Result<Hash, HasherError> {
        let commitment = self.get_commitment()?;
        let commitment_field = BigUint::from_bytes_le(&commitment);
        let signature = self
            .keypair
            .sign(&commitment_field, &BigUint::from(self.index));

        let nullifier: Vec<u8> = [
            commitment.as_slice(),
            self.index.to_le_bytes().as_slice(),
            &signature.to_bytes_le(),
        ]
        .concat();

        light_hasher::Poseidon::hash(&nullifier)
    }
}
