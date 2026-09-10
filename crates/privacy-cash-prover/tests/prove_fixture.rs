use std::path::PathBuf;
use std::time::Instant;

use privacy_cash_prover::{prove_circuit_json, CompressedProveResponse};

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/deposit_circuit.json")
}

fn hex_len(hex: &str) -> usize {
    hex.strip_prefix("0x")
        .unwrap_or(hex)
        .len()
        / 2
}

fn assert_compressed_layout(resp: &CompressedProveResponse) {
    assert_eq!(hex_len(&resp.proof_a), 32, "proof_a must be 32 bytes");
    assert_eq!(hex_len(&resp.proof_b), 64, "proof_b must be 64 bytes");
    assert_eq!(hex_len(&resp.proof_c), 32, "proof_c must be 32 bytes");
    assert_eq!(
        resp.public_signals.len(),
        7,
        "current circuit exposes 7 public inputs"
    );
}

#[test]
fn prove_fixture_emits_compressed_32_64_32_and_logs_latency() {
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture_path()).unwrap()).unwrap();
    let key_base = privacy_cash_prover::default_circuit_base();

    let started = Instant::now();
    let first = prove_circuit_json(&value, &key_base).expect("prove fixture");
    let first_ms = started.elapsed().as_millis();
    eprintln!("prove cold latency_ms={first_ms}");
    assert_compressed_layout(&first);

    let warmed = Instant::now();
    let second = prove_circuit_json(&value, &key_base).expect("prove fixture again");
    let warm_ms = warmed.elapsed().as_millis();
    eprintln!("prove warm latency_ms={warm_ms}");
    assert_compressed_layout(&second);
    // Witness-determined publics match; A/B/C are randomized (r, s).
    assert_eq!(first.public_signals, second.public_signals);
    assert_ne!(first.proof_a, second.proof_a);
    // Debug groth16 is tens of seconds; the hosted binary is `--release`.
    if !cfg!(debug_assertions) {
        assert!(
            warm_ms < 2_000,
            "release warm ark-groth16 should be hundreds of ms; got {warm_ms}ms"
        );
    }
}
