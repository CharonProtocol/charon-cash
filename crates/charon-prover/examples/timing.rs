//! Native timing split into parse, witness and prove.
//!   cargo run --release --example timing                          # rayon, all cores
//!   cargo run --release --example timing --no-default-features    # one thread, like the wasm build
use std::time::Instant;

use privacy_cash_prover::{default_circuit_base, proof_input_from_json, Prover};

fn median(mut xs: Vec<u128>) -> u128 {
    xs.sort_unstable();
    xs[xs.len() / 2]
}

fn main() -> anyhow::Result<()> {
    let runs: usize = std::env::var("RUNS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let base = default_circuit_base();
    let zkey = std::fs::read(base.with_extension("zkey"))?;
    let graph = std::fs::read(base.with_extension("graph"))?;

    let t = Instant::now();
    let prover = Prover::new(&zkey, &graph)?;
    println!(
        "threads: {}, zkey+graph parse: {} ms",
        if cfg!(feature = "parallel") {
            "all cores"
        } else {
            "1"
        },
        t.elapsed().as_millis()
    );

    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    for name in ["deposit", "withdraw", "spl"] {
        let json = std::fs::read_to_string(format!("{fixtures}/{name}_circuit.json"))?;
        let input = proof_input_from_json(&serde_json::from_str(&json)?)?;
        let (mut wit, mut prf) = (Vec::new(), Vec::new());
        for _ in 0..runs {
            let t = Instant::now();
            let witness = prover.witness(&input)?;
            wit.push(t.elapsed().as_micros());
            let t = Instant::now();
            prover.prove_witness(&witness, &mut rand::rngs::OsRng)?;
            prf.push(t.elapsed().as_micros());
        }
        println!(
            "{name:<8} witness {:.1} ms, prove+verify {:.1} ms (median of {runs})",
            median(wit) as f64 / 1000.0,
            median(prf) as f64 / 1000.0
        );
    }
    Ok(())
}
