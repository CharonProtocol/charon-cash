use std::path::PathBuf;
use std::time::Instant;

use privacy_cash_prover::{default_circuit_base, CompressedProveResponse, Prover};

fn fixture(name: &str) -> serde_json::Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn hex_len(hex: &str) -> usize {
    hex.strip_prefix("0x").unwrap_or(hex).len() / 2
}

fn assert_compressed_layout(resp: &CompressedProveResponse) {
    assert_eq!(hex_len(&resp.proof_a), 32, "proof_a must be 32 bytes");
    assert_eq!(hex_len(&resp.proof_b), 64, "proof_b must be 64 bytes");
    assert_eq!(hex_len(&resp.proof_c), 32, "proof_c must be 32 bytes");
    assert_eq!(
        resp.public_signals.len(),
        7,
        "circuit exposes 7 public inputs"
    );
}

#[test]
fn prove_fixtures_emit_compressed_32_64_32_and_log_latency() {
    let started = Instant::now();
    let prover = Prover::from_circuit_base(&default_circuit_base()).expect("load prover");
    eprintln!("load latency_ms={}", started.elapsed().as_millis());

    let deposit = fixture("deposit_circuit.json");
    let started = Instant::now();
    let first = prover.prove_value(&deposit).expect("prove deposit");
    eprintln!("prove cold latency_ms={}", started.elapsed().as_millis());
    assert_compressed_layout(&first);

    let started = Instant::now();
    let second = prover.prove_value(&deposit).expect("prove deposit again");
    let warm_ms = started.elapsed().as_millis();
    eprintln!("prove warm latency_ms={warm_ms}");
    assert_compressed_layout(&second);
    // Witness-determined publics match; A/B/C are randomized (r, s).
    assert_eq!(first.public_signals, second.public_signals);
    assert_ne!(first.proof_a, second.proof_a);

    for name in ["withdraw_circuit.json", "spl_circuit.json"] {
        let resp = prover.prove_value(&fixture(name)).expect(name);
        assert_compressed_layout(&resp);
    }

    // Debug groth16 is tens of seconds; only time the optimized build.
    if !cfg!(debug_assertions) {
        assert!(
            warm_ms < 2_000,
            "release warm prove should be well under 2s; got {warm_ms}ms"
        );
    }
}

#[test]
fn unsatisfied_input_is_rejected() {
    let prover = Prover::from_circuit_base(&default_circuit_base()).unwrap();
    let mut withdraw = fixture("withdraw_circuit.json");
    withdraw["root"] = serde_json::Value::String("12345".into());
    let err = prover.prove_value(&withdraw).unwrap_err();
    assert!(format!("{err:#}").contains("does not verify"), "{err:#}");
}
