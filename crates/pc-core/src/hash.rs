//! Poseidon over BN254, circom-compatible.
//!
//! Delegates to `light_hasher::Poseidon`, whose off-chain path is `light_poseidon`'s
//! `new_circom` (zero domain tag) — bit-identical to circomlib and to what the on-chain program
//! computes. Keeping the client on the *same crate* as the program removes an entire class of
//! "my hash disagrees with the chain" bugs.

use crate::field::{fr_from_be_bytes_mod_order, fr_to_be32};
use ark_bn254::Fr;
use light_hasher::{Hasher, Poseidon};

/// Poseidon hash of a slice of field elements, returned as a field element.
///
/// Arity is fixed by the number of inputs (circom uses a distinct permutation per width), so pass
/// exactly the inputs the circuit hashes — no padding.
pub fn poseidon(inputs: &[Fr]) -> Fr {
    let encoded: Vec<[u8; 32]> = inputs.iter().map(fr_to_be32).collect();
    let refs: Vec<&[u8]> = encoded.iter().map(|b| b.as_slice()).collect();
    let out = Poseidon::hashv(&refs).expect("poseidon over canonical field elements never fails");
    fr_from_be_bytes_mod_order(&out)
}

/// [`poseidon`] returning the raw big-endian bytes, for callers that want the on-wire form.
pub fn poseidon_be32(inputs: &[Fr]) -> [u8; 32] {
    fr_to_be32(&poseidon(inputs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::fr_from_decimal;

    // Canonical circomlibjs vectors `poseidon([1..n])` for every arity the protocol uses:
    // 1 (pubkey), 2 (merkle), 3 (nullifier/sign), 4 (commitment). All four passing means the hash
    // is circom-compatible across the board, independent of any fixture.
    #[test]
    fn matches_canonical_circomlib_vectors() {
        let cases: &[(&[&str], &str)] = &[
            (
                &["1"],
                "18586133768512220936620570745912940619677854269274689475585506675881198879027",
            ),
            (
                &["1", "2"],
                "7853200120776062878684798364095072458815029376092732009249414926327459813530",
            ),
            (
                &["1", "2", "3"],
                "6542985608222806190361240322586112750744169038454362455181422643027100751666",
            ),
            (
                &["1", "2", "3", "4"],
                "18821383157269793795438455681495246036402687001665670618754263018637548127333",
            ),
        ];
        for (inputs, want) in cases {
            let fr: Vec<_> = inputs.iter().map(|s| fr_from_decimal(s)).collect();
            assert_eq!(poseidon(&fr), fr_from_decimal(want), "arity {}", inputs.len());
        }
    }
}
