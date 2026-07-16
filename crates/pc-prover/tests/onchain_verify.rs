//! The definitive Phase 3 gate: a proof produced by `pc-prover` is accepted by the *program's own*
//! Groth16 verifier.
//!
//! This is the only check that actually exercises the on-chain byte format — the un-negated
//! `proofA` (the verifier negates it) and the c1-before-c0 Fp2 ordering of `proofB`. If either is
//! wrong, `verify_proof` returns false here, long before a devnet transaction would.
//!
//! `verify_proof` runs the alt-bn128 pairing on the host via `solana-bn254`, so no validator is
//! needed. It checks only the pairing equation against the seven public inputs; the root value is
//! irrelevant to it (that is `is_known_root`'s job), so the golden fixture's arbitrary `root = 42`
//! is fine.

mod common;

use privacy_cash::state::Proof;
use privacy_cash::utils::{verify_proof, VERIFYING_KEY};

#[test]
fn program_verifier_accepts_pc_prover_proof() {
    let pb = common::prove_golden_deposit();

    let proof = Proof {
        proof_a: pb.proof_a,
        proof_b: pb.proof_b,
        proof_c: pb.proof_c,
        root: pb.public_signals[0],
        public_amount: pb.public_signals[1],
        ext_data_hash: pb.public_signals[2],
        input_nullifiers: [pb.public_signals[3], pb.public_signals[4]],
        output_commitments: [pb.public_signals[5], pb.public_signals[6]],
    };

    assert!(
        verify_proof(&proof, &VERIFYING_KEY),
        "on-chain verifier rejected a pc-prover proof — serialization (negation / Fp2 order) is wrong"
    );
}

#[test]
fn program_verifier_rejects_tampered_public_input() {
    let pb = common::prove_golden_deposit();
    let mut proof = Proof {
        proof_a: pb.proof_a,
        proof_b: pb.proof_b,
        proof_c: pb.proof_c,
        root: pb.public_signals[0],
        public_amount: pb.public_signals[1],
        ext_data_hash: pb.public_signals[2],
        input_nullifiers: [pb.public_signals[3], pb.public_signals[4]],
        output_commitments: [pb.public_signals[5], pb.public_signals[6]],
    };
    // Flip a commitment: the pairing must now fail.
    proof.output_commitments[0][31] ^= 1;
    assert!(!verify_proof(&proof, &VERIFYING_KEY));
}
