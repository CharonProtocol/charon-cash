//! BN254 scalar field (`Fr`) helpers.
//!
//! Everything the circuit and the on-chain program exchange is a field element serialized as a
//! canonical 32-byte **big-endian** integer. This module is the single place that conversion
//! lives, so byte-order mistakes — the most common way a ZK port silently produces invalid
//! proofs — have exactly one place to be wrong and one place to fix.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use num_bigint::BigUint;

/// The BN254 scalar field modulus, as decimal. Matches `FIELD_SIZE` in the TS `constants.ts`.
pub const FIELD_MODULUS_DEC: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

/// Convert an `Fr` to its canonical 32-byte big-endian encoding.
///
/// `Fr` is always less than the modulus, so the result is always canonical and safe to feed to
/// `light_hasher`'s `hash_bytes_be` (which rejects non-canonical inputs).
pub fn fr_to_be32(x: &Fr) -> [u8; 32] {
    let bytes = x.into_bigint().to_bytes_be(); // Vec<u8>, big-endian, 32 bytes for BN254
    let mut out = [0u8; 32];
    // Left-pad in case a small value serialized to fewer than 32 bytes.
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

/// Read a field element from big-endian bytes, reducing modulo the field order.
///
/// This mirrors `Fr::from_be_bytes_mod_order`, which is how the program reads every public input.
pub fn fr_from_be_bytes_mod_order(bytes: &[u8]) -> Fr {
    Fr::from_be_bytes_mod_order(bytes)
}

/// Read a field element from little-endian bytes, reducing modulo the field order.
///
/// The one place this matters is `extDataHash`: the client feeds the raw SHA-256 digest to the
/// circuit interpreted **little-endian** (snarkjs `fromRprLE`), and the program checks with
/// `Fr::from_le_bytes_mod_order`. See [`crate::ext_data`].
pub fn fr_from_le_bytes_mod_order(bytes: &[u8]) -> Fr {
    Fr::from_le_bytes_mod_order(bytes)
}

/// Parse a decimal string into a field element, reducing modulo the field order.
///
/// Used for fixed protocol constants (e.g. the SOL mint field) and in tests, which express
/// values as the same decimal strings the TypeScript reference uses.
pub fn fr_from_decimal(s: &str) -> Fr {
    let n = BigUint::parse_bytes(s.as_bytes(), 10).expect("valid decimal");
    Fr::from(n)
}

/// A `u64` as a field element.
pub fn fr_from_u64(x: u64) -> Fr {
    Fr::from(x)
}

/// Render a field element as its decimal string — the form the circom witness calculator expects.
pub fn fr_to_decimal(x: &Fr) -> String {
    BigUint::from_bytes_be(&fr_to_be32(x)).to_str_radix(10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_be32() {
        let x = fr_from_u64(100);
        let be = fr_to_be32(&x);
        // 100 is small, so all but the last byte are zero and the last is 100.
        assert_eq!(be[31], 100);
        assert!(be[..31].iter().all(|&b| b == 0));
        assert_eq!(fr_from_be_bytes_mod_order(&be), x);
    }

    #[test]
    fn modulus_reduces_to_zero() {
        assert_eq!(fr_from_decimal(FIELD_MODULUS_DEC), Fr::from(0u64));
    }

    #[test]
    fn decimal_round_trips() {
        let x = fr_from_decimal("12345678901234567890");
        assert_eq!(fr_to_decimal(&x), "12345678901234567890");
    }
}
