//! Recomputation of `ext_data_hash`.
//!
//! This is the check that makes the relayer trust-minimized. Recipient, amount,
//! fee, fee recipient, mint, and both ciphertexts are all covered by this hash,
//! and the hash is a Groth16 public input the program verifies. If our recomputed
//! hash matches the one inside the proof, the transaction we are about to build is
//! provably the transaction the user proved — we cannot redirect it, and we cannot
//! be tricked into building something else.
//!
//! Byte layout and the comparison rule both mirror
//! `programs/privacy-cash/src/utils.rs` (`calculate_complete_ext_data_hash` and
//! `ext_data_hash_matches`). Any divergence here would make us reject valid
//! requests or pay for transactions the program will refuse.

use sha2::{Digest, Sha256};

/// BN254 scalar field modulus, big-endian. Mirrors `groth16::FR_MODULUS_BE`.
const FR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Clone, Copy)]
pub struct ExtData<'a> {
    pub recipient: [u8; 32],
    pub ext_amount: i64,
    pub encrypted_output1: &'a [u8],
    pub encrypted_output2: &'a [u8],
    pub fee: u64,
    pub fee_recipient: [u8; 32],
    pub mint_address: [u8; 32],
}

/// `recipient(32) | ext_amount i64 LE | len1 u32 LE | enc1 | len2 u32 LE | enc2
///  | fee u64 LE | fee_recipient(32) | mint(32)`, SHA-256'd.
pub fn complete_ext_data_hash(ext: &ExtData<'_>) -> [u8; 32] {
    let mut data = Vec::with_capacity(
        32 + 8 + 4 + ext.encrypted_output1.len() + 4 + ext.encrypted_output2.len() + 8 + 32 + 32,
    );
    data.extend_from_slice(&ext.recipient);
    data.extend_from_slice(&ext.ext_amount.to_le_bytes());
    data.extend_from_slice(&(ext.encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(ext.encrypted_output1);
    data.extend_from_slice(&(ext.encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(ext.encrypted_output2);
    data.extend_from_slice(&ext.fee.to_le_bytes());
    data.extend_from_slice(&ext.fee_recipient);
    data.extend_from_slice(&ext.mint_address);

    let digest = Sha256::digest(&data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// The circuit reads the SHA-256 digest little-endian while the proof stores the
/// field element big-endian, so both sides are byte-reversed and reduced mod r
/// before comparison. Reduction is repeated subtraction to match the program
/// exactly rather than relying on a bignum crate.
pub fn ext_data_hash_matches(calculated: &[u8; 32], proof_hash: &[u8; 32]) -> bool {
    fr_reduce_be(&swab32(calculated)) == fr_reduce_be(proof_hash)
}

fn swab32(bytes: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = bytes[31 - i];
    }
    out
}

fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> core::cmp::Ordering {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    core::cmp::Ordering::Equal
}

fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let av = a[i] as u16;
        let bv = b[i] as u16 + borrow;
        if av >= bv {
            out[i] = (av - bv) as u8;
            borrow = 0;
        } else {
            out[i] = (av + 256 - bv) as u8;
            borrow = 1;
        }
    }
    out
}

fn fr_reduce_be(bytes: &[u8; 32]) -> [u8; 32] {
    let mut x = *bytes;
    while cmp_be(&x, &FR_MODULUS_BE) != core::cmp::Ordering::Less {
        x = sub_be(&x, &FR_MODULUS_BE);
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduction_is_idempotent_below_modulus() {
        let mut small = [0u8; 32];
        small[31] = 7;
        assert_eq!(fr_reduce_be(&small), small);
    }

    #[test]
    fn modulus_reduces_to_zero() {
        assert_eq!(fr_reduce_be(&FR_MODULUS_BE), [0u8; 32]);
    }

    #[test]
    fn swab_is_an_involution() {
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(swab32(&swab32(&bytes)), bytes);
    }

    /// A hash whose byte-reversal exceeds the modulus must still compare equal to
    /// the reduced field element the circuit would have produced.
    #[test]
    fn comparison_reduces_both_sides() {
        let calculated = [0xffu8; 32];
        let reduced = fr_reduce_be(&swab32(&calculated));
        assert!(ext_data_hash_matches(&calculated, &reduced));
    }

    #[test]
    fn hash_layout_is_length_prefixed() {
        // Moving a byte from the first ciphertext to the second must change the
        // digest even though the concatenation is otherwise identical: that is what
        // the u32 length prefixes buy.
        let a = ExtData {
            recipient: [1u8; 32],
            ext_amount: -5,
            encrypted_output1: &[9, 9],
            encrypted_output2: &[9],
            fee: 3,
            fee_recipient: [2u8; 32],
            mint_address: [3u8; 32],
        };
        let b = ExtData {
            encrypted_output1: &[9],
            encrypted_output2: &[9, 9],
            ..a
        };
        assert_ne!(complete_ext_data_hash(&a), complete_ext_data_hash(&b));
    }
}
