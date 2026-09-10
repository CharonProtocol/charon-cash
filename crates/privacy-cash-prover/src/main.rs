use std::io::{Read, Write};
use std::time::Instant;

use anyhow::Result;
use privacy_cash_prover::{default_circuit_base, prove_circuit_json, serve_stdio_loop};

fn main() {
    if let Err(err) = run() {
        eprintln!("{err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "serve") {
        return serve_stdio_loop();
    }

    let mut stdin = Vec::new();
    std::io::stdin().read_to_end(&mut stdin)?;
    let value: serde_json::Value = serde_json::from_slice(&stdin)?;
    let started = Instant::now();
    let response = prove_circuit_json(&value, &default_circuit_base())?;
    eprintln!("prove latency_ms={}", started.elapsed().as_millis());
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
