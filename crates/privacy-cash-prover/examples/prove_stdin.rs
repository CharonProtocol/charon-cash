//! Circuit-input JSON on stdin -> the same `{proof_a, proof_b, proof_c,
//! public_signals}` JSON the wasm and Android (JNI) bindings return.
//! Host stand-in for the mobile prover in tests:
//!   cargo run --release --example prove_stdin < input.json

use std::io::Read;

fn main() -> anyhow::Result<()> {
    let prover = privacy_cash_prover::Prover::from_circuit_base(&privacy_cash_prover::default_circuit_base())?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    println!("{}", serde_json::to_string(&prover.prove_json(&input)?)?);
    Ok(())
}
