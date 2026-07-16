//! UTXOs (notes), with commitment and nullifier derivation.
//!
//! ```text
//! commitment = Poseidon(amount, pubkey, blinding, mintField)
//! nullifier  = Poseidon(commitment, index, Poseidon(privkey, commitment, index))
//! ```
//!
//! `index` is the leaf index the commitment occupies in the tree, and it is bound into *both* the
//! nullifier and (via the circuit) the Merkle path. So a note's `index` must be set to its true
//! on-chain leaf index — the value the [`pc_types::CommitmentEvent`] carries — before its
//! nullifier is computed. Getting this wrong yields a valid-looking nullifier the chain rejects.

use crate::field::{fr_from_u64, fr_to_be32};
use crate::hash::poseidon;
use crate::keypair::Keypair;
use crate::mint::{mint_address_field, SOL_MINT};
use ark_bn254::Fr;
use ark_ff::UniformRand;
use rand_core::OsRng;

/// A single note.
#[derive(Clone, Copy, Debug)]
pub struct Utxo {
    pub amount: u64,
    pub blinding: Fr,
    pub keypair: Keypair,
    /// Leaf index. Meaningful only once the note is on-chain; for outputs being created it is a
    /// placeholder until the [`pc_types::CommitmentEvent`] reports the real value.
    pub index: u32,
    pub mint: [u8; 32],
}

impl Utxo {
    /// A brand-new output note with a uniformly-sampled blinding.
    ///
    /// The blinding is drawn as a full field element via rejection sampling (`Fr::rand`), *not*
    /// the ~30-bit `Math.random()` the reference TS uses — that would make notes guessable.
    pub fn new(amount: u64, keypair: Keypair, mint: [u8; 32]) -> Self {
        Self {
            amount,
            blinding: Fr::rand(&mut OsRng),
            keypair,
            index: 0,
            mint,
        }
    }

    /// A zero-value dummy input. The circuit disables the Merkle check when `amount == 0`, so a
    /// dummy needs no real path — only a fresh keypair so its nullifier is unique.
    pub fn dummy() -> Self {
        Self {
            amount: 0,
            blinding: Fr::rand(&mut OsRng),
            keypair: Keypair::generate(),
            index: 0,
            mint: SOL_MINT,
        }
    }

    /// Reconstruct a note from decrypted fields (see `pc-note`). `index` comes from the event.
    pub fn from_parts(amount: u64, blinding: Fr, keypair: Keypair, index: u32, mint: [u8; 32]) -> Self {
        Self { amount, blinding, keypair, index, mint }
    }

    /// `Poseidon(amount, pubkey, blinding, mintField)`.
    pub fn commitment(&self) -> Fr {
        poseidon(&[
            fr_from_u64(self.amount),
            self.keypair.pubkey(),
            self.blinding,
            mint_address_field(&self.mint),
        ])
    }

    pub fn commitment_be32(&self) -> [u8; 32] {
        fr_to_be32(&self.commitment())
    }

    /// `Poseidon(commitment, index, sign(commitment, index))`.
    pub fn nullifier(&self) -> Fr {
        let commitment = self.commitment();
        let index = fr_from_u64(self.index as u64);
        let signature = self.keypair.sign(commitment, index);
        poseidon(&[commitment, index, signature])
    }

    pub fn nullifier_be32(&self) -> [u8; 32] {
        fr_to_be32(&self.nullifier())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::{fr_from_decimal, fr_to_be32};

    // Reproduces `generate_rust_proof_fixture.js` exactly, and checks the commitments and
    // nullifiers against the public inputs baked into the upstream groth16 fixture. This is the
    // Phase 2 parity gate: if Poseidon or any formula/byte-order is off, it fails here — before
    // any proving is involved.
    //
    // Fixture: mint = "1" (a raw field value, not a real pubkey), index = 0.
    fn utxo_with(priv_dec: &str, blinding_dec: &str, amount: u64) -> Utxo {
        let keypair = Keypair::from_privkey_be(&fr_to_be32(&fr_from_decimal(priv_dec)));
        Utxo {
            amount,
            blinding: fr_from_decimal(blinding_dec),
            keypair,
            index: 0,
            // mint field == 1: a 32-byte value whose big-endian integer is 1, and NOT SOL_MINT,
            // so mint_address_field takes the SPL branch = BigUint(mint[0..31]) = 1.
            mint: {
                let mut m = [0u8; 32];
                m[30] = 1; // byte 30 is the last of the first-31 window → value 1
                m
            },
        }
    }

    // Golden values from crates/pc-core/tests/fixtures/golden_deposit.json, produced by the
    // upstream snarkjs+hasher.rs stack and snarkjs-verified. (The committed groth16_test.rs
    // fixture uses a *different*, withdrawal input set, so its public inputs are NOT these.)
    const NULLIFIER_0: [u8; 32] = [
        37, 153, 182, 104, 41, 232, 21, 174, 137, 122, 198, 7, 250, 172, 173, 254, 74, 76, 162,
        192, 173, 185, 120, 221, 6, 190, 219, 244, 81, 12, 99, 85,
    ];
    const NULLIFIER_1: [u8; 32] = [
        20, 104, 248, 161, 252, 84, 29, 160, 152, 56, 53, 145, 221, 119, 193, 100, 225, 181, 20,
        201, 131, 78, 247, 9, 43, 138, 142, 182, 117, 179, 127, 9,
    ];
    const COMMITMENT_0: [u8; 32] = [
        0, 11, 198, 70, 122, 21, 21, 49, 98, 10, 45, 239, 39, 31, 4, 22, 134, 101, 197, 36, 1, 231,
        136, 59, 13, 56, 206, 45, 0, 77, 73, 118,
    ];
    const COMMITMENT_1: [u8; 32] = [
        9, 205, 58, 207, 161, 212, 208, 179, 135, 15, 58, 121, 140, 65, 42, 42, 74, 180, 96, 6,
        162, 186, 75, 160, 116, 30, 126, 127, 169, 228, 222, 144,
    ];

    #[test]
    fn input_nullifiers_match_golden_fixture() {
        let in0 = utxo_with("11111", "222", 0);
        let in1 = utxo_with("33333", "444", 0);
        assert_eq!(in0.nullifier_be32(), NULLIFIER_0);
        assert_eq!(in1.nullifier_be32(), NULLIFIER_1);
    }

    #[test]
    fn output_commitments_match_golden_fixture() {
        let out0 = utxo_with("55555", "666", 100);
        let out1 = utxo_with("77777", "888", 0);
        assert_eq!(out0.commitment_be32(), COMMITMENT_0);
        assert_eq!(out1.commitment_be32(), COMMITMENT_1);
    }
}
