//! The witness graph must produce exactly the witness the circom wasm
//! (run through Wasmer by ark-circom) produces, for every fixture.

use std::path::PathBuf;

use ark_bn254::Fr;
use ark_circom::WitnessCalculator;
use num_bigint::BigInt;
use privacy_cash_prover::{
    circuit_inputs, default_circuit_base, proof_input_from_json, WitnessGraph,
};
use wasmer::Store;

fn fixture(name: &str) -> serde_json::Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../privacy-cash-prover/tests/fixtures")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn assert_same_witness(name: &str) {
    let base = default_circuit_base();
    let input = proof_input_from_json(&fixture(name)).unwrap();
    let inputs = circuit_inputs(&input).unwrap();

    let graph =
        WitnessGraph::from_bytes(&std::fs::read(base.with_extension("graph")).unwrap()).unwrap();
    let from_graph = graph.calculate_witness(&inputs).unwrap();

    let mut store = Store::default();
    let mut wc = WitnessCalculator::new(&mut store, base.with_extension("wasm")).unwrap();
    let wasm_inputs = inputs
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                v.iter().map(|x| BigInt::from(x.clone())).collect(),
            )
        })
        .collect::<Vec<(String, Vec<BigInt>)>>();
    let from_wasm: Vec<Fr> = wc
        .calculate_witness_element::<Fr, _>(&mut store, wasm_inputs, true)
        .unwrap();

    assert_eq!(from_graph.len(), from_wasm.len(), "{name}: witness length");
    if let Some(i) = (0..from_wasm.len()).find(|&i| from_graph[i] != from_wasm[i]) {
        panic!(
            "{name}: witness differs at index {i}: graph={} wasm={}",
            from_graph[i], from_wasm[i]
        );
    }
}

#[test]
fn deposit_witness_matches_circom_wasm() {
    assert_same_witness("deposit_circuit.json");
}

#[test]
fn withdraw_with_path_witness_matches_circom_wasm() {
    assert_same_witness("withdraw_circuit.json");
}

#[test]
fn spl_mint_witness_matches_circom_wasm() {
    assert_same_witness("spl_circuit.json");
}
