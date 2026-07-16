//! Shared golden-deposit proving for the pc-prover integration tests.

use pc_core::field::fr_from_decimal;
use pc_core::hash::poseidon;
use pc_core::Fr;
use pc_prover::{prove, CircuitInputs, ProofBytes, MERKLE_DEPTH};
use std::path::PathBuf;

pub fn zkey_path() -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../artifacts/circuits/transaction2.zkey")
        .to_str()
        .unwrap()
        .to_string()
}

/// The exact golden deposit inputs (mirrors tests/fixtures/generate_golden.js).
pub fn golden_inputs() -> CircuitInputs {
    let dec = fr_from_decimal;
    let commit = |amount: &str, pubkey: Fr, blinding: &str| {
        poseidon(&[dec(amount), pubkey, dec(blinding), dec("1")])
    };
    let nullifier = |commitment: Fr, priv_key: &str| {
        let sig = poseidon(&[dec(priv_key), commitment, dec("0")]);
        poseidon(&[commitment, dec("0"), sig])
    };

    let in0_pub = poseidon(&[dec("11111")]);
    let in0_c = commit("0", in0_pub, "222");
    let in1_pub = poseidon(&[dec("33333")]);
    let in1_c = commit("0", in1_pub, "444");
    let out0_pub = poseidon(&[dec("55555")]);
    let out0_c = commit("100", out0_pub, "666");
    let out1_pub = poseidon(&[dec("77777")]);
    let out1_c = commit("0", out1_pub, "888");

    CircuitInputs {
        root: dec("42"),
        public_amount: dec("100"),
        ext_data_hash: dec("12345"),
        mint_address: dec("1"),
        input_nullifiers: [nullifier(in0_c, "11111"), nullifier(in1_c, "33333")],
        in_amounts: [dec("0"), dec("0")],
        in_private_keys: [dec("11111"), dec("33333")],
        in_blindings: [dec("222"), dec("444")],
        in_path_indices: [dec("0"), dec("0")],
        in_path_elements: [[Fr::from(0u64); MERKLE_DEPTH]; 2],
        output_commitments: [out0_c, out1_c],
        out_amounts: [dec("100"), dec("0")],
        out_pubkeys: [out0_pub, out1_pub],
        out_blindings: [dec("666"), dec("888")],
    }
}

pub fn prove_golden_deposit() -> ProofBytes {
    prove(&golden_inputs(), &zkey_path()).expect("proving failed")
}
