//! External-data hashing.
//!
//! `extDataHash` binds the parts of a transaction that are *not* inside the shielded UTXOs — the
//! recipient, the signed amount, the fee, the fee recipient, the mint, and the two encrypted
//! outputs — into the proof, so a frontrunner cannot rewrite them. Two traps, both handled here:
//!
//! * The hash is **SHA-256**, not keccak.
//! * The digest becomes a field element interpreted **little-endian**
//!   (`Fr::from_le_bytes_mod_order`), while it is transmitted to the program **big-endian**. The
//!   program reconciles the two, so the client must feed the circuit the LE reading and put the BE
//!   encoding of *that field element* into `proof.ext_data_hash`.
//!
//! The byte layout mirrors `calculate_complete_ext_data_hash` in the program exactly (a
//! hand-rolled Borsh serialization: fixed fields plus `u32`-length-prefixed `Vec<u8>`s).

use crate::field::{fr_from_le_bytes_mod_order, fr_to_be32};
use sha2::{Digest, Sha256};

/// The external data committed alongside a transaction.
pub struct ExtData<'a> {
    /// For SOL, the recipient wallet. For SPL, the recipient's **token account** (ATA).
    pub recipient: [u8; 32],
    /// Signed net amount: positive = deposit, negative = withdrawal.
    pub ext_amount: i64,
    pub encrypted_output1: &'a [u8],
    pub encrypted_output2: &'a [u8],
    pub fee: u64,
    /// For SOL, the fee recipient wallet. For SPL, its **token account**.
    pub fee_recipient: [u8; 32],
    /// The full 32-byte mint pubkey (unlike the circuit's `mintAddress`, which is truncated).
    pub mint_address: [u8; 32],
}

impl ExtData<'_> {
    /// The exact bytes the program feeds to SHA-256.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(
            32 + 8 + 4 + self.encrypted_output1.len() + 4 + self.encrypted_output2.len() + 8 + 32 + 32,
        );
        data.extend_from_slice(&self.recipient);
        data.extend_from_slice(&self.ext_amount.to_le_bytes());
        data.extend_from_slice(&(self.encrypted_output1.len() as u32).to_le_bytes());
        data.extend_from_slice(self.encrypted_output1);
        data.extend_from_slice(&(self.encrypted_output2.len() as u32).to_le_bytes());
        data.extend_from_slice(self.encrypted_output2);
        data.extend_from_slice(&self.fee.to_le_bytes());
        data.extend_from_slice(&self.fee_recipient);
        data.extend_from_slice(&self.mint_address);
        data
    }

    /// The raw SHA-256 digest — equal to the program's locally-computed `calculated` hash.
    pub fn hash_digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.to_bytes());
        hasher.finalize().into()
    }

    /// The `extDataHash` public-input bytes to place in `proof.ext_data_hash` (big-endian
    /// encoding of the little-endian reading of the digest).
    pub fn hash_field_be32(&self) -> [u8; 32] {
        fr_to_be32(&fr_from_le_bytes_mod_order(&self.hash_digest()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_deterministic_and_order_sensitive() {
        let base = ExtData {
            recipient: [1u8; 32],
            ext_amount: -16941,
            encrypted_output1: b"enc1",
            encrypted_output2: b"enc2",
            fee: 59,
            fee_recipient: [2u8; 32],
            mint_address: [3u8; 32],
        };
        let a = base.hash_digest();
        // Flipping the sign of ext_amount must change the digest (guards the i64 LE encoding).
        let flipped = ExtData { ext_amount: 16941, ..base_copy(&base) };
        assert_ne!(a, flipped.hash_digest());
        // And the field encoding is stable.
        assert_eq!(base.hash_field_be32(), base.hash_field_be32());
    }

    fn base_copy<'a>(b: &ExtData<'a>) -> ExtData<'a> {
        ExtData {
            recipient: b.recipient,
            ext_amount: b.ext_amount,
            encrypted_output1: b.encrypted_output1,
            encrypted_output2: b.encrypted_output2,
            fee: b.fee,
            fee_recipient: b.fee_recipient,
            mint_address: b.mint_address,
        }
    }
}
