//! Phase 3 gate: prove the golden deposit and check the deterministic outputs.
//!
//! The proof points are randomized, so we cannot compare them to a stored blob. What we *can*
//! pin is that the public signals equal the snarkjs-verified golden fixture. Byte-format
//! correctness (negation, Fp2 order) is checked in `onchain_verify.rs` against the real verifier.

mod common;

use pc_core::field::fr_to_be32;

#[test]
fn proves_golden_deposit_with_correct_public_signals() {
    let inputs = common::golden_inputs();
    let proof = common::prove_golden_deposit();

    // signal[0]=root, [1]=publicAmount, [3]=nullifier0, [5]=commitment0 — all deterministic.
    assert_eq!(proof.public_signals[0], fr_to_be32(&inputs.root));
    assert_eq!(proof.public_signals[1], fr_to_be32(&inputs.public_amount));
    assert_eq!(proof.public_signals[3], fr_to_be32(&inputs.input_nullifiers[0]));
    assert_eq!(proof.public_signals[5], fr_to_be32(&inputs.output_commitments[0]));

    // Golden commitment0 from the snarkjs-verified fixture.
    const GOLDEN_COMMITMENT_0: [u8; 32] = [
        0, 11, 198, 70, 122, 21, 21, 49, 98, 10, 45, 239, 39, 31, 4, 22, 134, 101, 197, 36, 1, 231,
        136, 59, 13, 56, 206, 45, 0, 77, 73, 118,
    ];
    assert_eq!(proof.public_signals[5], GOLDEN_COMMITMENT_0);

    assert!(proof.proof_a.iter().any(|&b| b != 0));
    assert!(proof.proof_b.iter().any(|&b| b != 0));
    assert!(proof.proof_c.iter().any(|&b| b != 0));
}
