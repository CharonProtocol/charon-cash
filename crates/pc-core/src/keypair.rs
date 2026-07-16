//! Shielded keypair.
//!
//! This is not a signature scheme in the usual sense — the "signature" is a Poseidon PRF whose
//! only job is to make nullifiers unlinkable to commitments. The circuit
//! (`keypair.circom`) constrains `pubkey = Poseidon(privkey)` and
//! `signature = Poseidon(privkey, commitment, merklePath)`, and nothing else about the key.

use crate::field::{fr_from_be_bytes_mod_order, fr_to_be32};
use crate::hash::poseidon;
use ark_bn254::Fr;
use rand_core::{OsRng, RngCore};

/// A shielded keypair: a field-element private key and its Poseidon image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keypair {
    privkey: Fr,
    pubkey: Fr,
}

impl Keypair {
    /// Build from an existing private key (any bytes, reduced into the field).
    pub fn from_privkey_be(bytes: &[u8; 32]) -> Self {
        let privkey = fr_from_be_bytes_mod_order(bytes);
        Self {
            privkey,
            pubkey: poseidon(&[privkey]),
        }
    }

    /// Generate a fresh keypair from the OS CSPRNG.
    ///
    /// Reducing 32 random bytes mod the field is very slightly non-uniform (the top ~3 bits), but
    /// harmless for a secret key — unlike a *blinding*, where we sample properly (see [`crate::Utxo`]).
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        OsRng.fill_bytes(&mut bytes);
        Self::from_privkey_be(&bytes)
    }

    pub fn privkey(&self) -> Fr {
        self.privkey
    }

    pub fn pubkey(&self) -> Fr {
        self.pubkey
    }

    pub fn privkey_be(&self) -> [u8; 32] {
        fr_to_be32(&self.privkey)
    }

    pub fn pubkey_be(&self) -> [u8; 32] {
        fr_to_be32(&self.pubkey)
    }

    /// The PRF `Poseidon(privkey, commitment, merkle_path)`.
    ///
    /// `merkle_path` is the leaf index as a field element (the circuit bit-decomposes it).
    pub fn sign(&self, commitment: Fr, merkle_path: Fr) -> Fr {
        poseidon(&[self.privkey, commitment, merkle_path])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::fr_from_decimal;

    #[test]
    fn pubkey_is_poseidon_of_privkey() {
        // Matches the fixture generator: pub = P([priv]).
        let kp = Keypair::from_privkey_be(&fr_to_be32(&fr_from_decimal("11111")));
        assert_eq!(kp.pubkey(), poseidon(&[fr_from_decimal("11111")]));
    }
}
