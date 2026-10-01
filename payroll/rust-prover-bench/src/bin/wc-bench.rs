// A/B witness-generation benchmark for transaction2:
//   wasm  = ark-circom's calculator running transaction2.wasm inside wasmer
//           (what prover-server uses today)
//   native= rust-witness's C-transpiled build of the same transaction2.wasm
// Both consume the identical signal map (fixtures/input.json) and the run
// asserts they agree modulo the BN254 scalar field, so the speedup is real
// and correct, not a different witness.

use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::time::Instant;

use ark_bn254::Fr;
use ark_circom::CircomConfig;
use num_bigint::{BigInt, BigUint};
use rust_witness::witness;

witness!(transaction2);

const DEFAULT_INPUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/input.json");
const CIRCUIT: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../programs/privacy-cash/artifacts/circuits/transaction2");
const NATIVE_RUNS: usize = 10;
const WASM_RUNS: usize = 5;

fn flatten(v: &serde_json::Value, out: &mut Vec<BigInt>) {
    match v {
        serde_json::Value::Array(items) => items.iter().for_each(|x| flatten(x, out)),
        serde_json::Value::String(s) => {
            let t = s.trim_start_matches("0x");
            let v = BigInt::parse_bytes(t.as_bytes(), 10)
                .or_else(|| BigInt::parse_bytes(t.as_bytes(), 16));
            out.push(v.unwrap());
        }
        serde_json::Value::Number(n) => {
            out.push(BigInt::parse_bytes(n.to_string().as_bytes(), 10).unwrap())
        }
        serde_json::Value::Object(map) => {
            if let Some(data) = map.get("data").and_then(|d| d.as_array()) {
                let bytes: Vec<u8> = data.iter().map(|x| x.as_u64().unwrap() as u8).collect();
                out.push(BigUint::from_bytes_le(&bytes).into());
            } else if map.contains_key("0") {
                let mut i = 0usize;
                while let Some(v) = map.get(&i.to_string()) {
                    let n = v
                        .as_u64()
                        .or_else(|| v.as_i64().map(|x| x as u64))
                        .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
                        .unwrap_or_else(|| panic!("bad array value {v}"));
                    out.push(BigInt::from(n));
                    i += 1;
                }
            }
        }
        other => panic!("unsupported input value {other}"),
    }
}

fn fr_to_biguint(f: &Fr) -> BigUint {
    f.clone().into()
}

fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;
    let input_path = env::args().nth(1).unwrap_or_else(|| DEFAULT_INPUT.to_string());
    let raw: serde_json::Value = serde_json::from_reader(File::open(&input_path)?)?;
    let mut inputs: HashMap<String, Vec<BigInt>> = HashMap::new();
    if let Some(map) = raw.as_object() {
        for (k, v) in map {
            let mut flat = Vec::new();
            flatten(v, &mut flat);
            inputs.insert(k.clone(), flat);
        }
    }
    println!("input      {input_path}  ({} signals)", inputs.len());

    // --- native (rust-witness): warm once, then time ---
    let t = Instant::now();
    let native_ref = transaction2_witness(inputs.iter().map(|(k, v)| (k.clone(), v.clone())));
    println!("native warmup (incl. one-time init) {:?}", t.elapsed());

    let mut native_ms = Vec::new();
    for i in 0..NATIVE_RUNS {
        let t = Instant::now();
        let w = transaction2_witness(inputs.iter().map(|(k, v)| (k.clone(), v.clone())));
        if i == 0 && w.len() != native_ref.len() {
            return Err(color_eyre::Report::msg("native witness length unstable"));
        }
        native_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }

    // --- wasm (ark-circom wasmer): load, warm once, then time ---
    let t = Instant::now();
    let mut cfg = CircomConfig::<Fr>::new(format!("{CIRCUIT}.wasm"), format!("{CIRCUIT}.r1cs"))?;
    println!("wasm load                                       {:?}", t.elapsed());

    let t = Instant::now();
    let wasm_ref = cfg
        .wtns
        .calculate_witness_element::<Fr, _>(&mut cfg.store, inputs.clone(), false)?;
    println!("wasm warmup                                     {:?}", t.elapsed());

    let mut wasm_ms = Vec::new();
    for _ in 0..WASM_RUNS {
        let t = Instant::now();
        let w = cfg
            .wtns
            .calculate_witness_element::<Fr, _>(&mut cfg.store, inputs.clone(), false)?;
        if w.len() != wasm_ref.len() {
            return Err(color_eyre::Report::msg("wasm witness length unstable"));
        }
        wasm_ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }

    // --- correctness: same witness modulo the field prime ---
    let mismatches = wasm_ref
        .iter()
        .zip(native_ref.iter())
        .filter(|(w, n)| {
            let nb: BigUint = n.to_biguint().unwrap_or_default();
            fr_to_biguint(w) != fr_to_biguint(&Fr::from(nb))
        })
        .count();
    if wasm_ref.len() != native_ref.len() || mismatches > 0 {
        return Err(color_eyre::Report::msg(format!(
            "witness mismatch: wasm {} elements vs native {}, {mismatches} field mismatches",
            wasm_ref.len(),
            native_ref.len()
        )));
    }
    println!(
        "witness match  OK  ({} elements, identical mod BN254 prime)",
        wasm_ref.len()
    );

    let avg = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let (wn, ww) = (avg(&native_ms), avg(&wasm_ms));
    println!("\n=== witnessgen A/B (transaction2) ===");
    println!("wasm   (wasmer, today)  {:>8.1} ms  ({} runs)", ww, WASM_RUNS);
    println!("native (rust-witness)   {:>8.1} ms  ({} runs)", wn, NATIVE_RUNS);
    println!("speedup                 {:>8.1}x", ww / wn);
    // prover-server's recorded full proof on this machine is ~280 ms including
    // the wasm witnessgen; project the same prove cost with the native witness.
    println!("projected per-proof    ~{:.0} ms  (was 280 ms incl. {:.1} ms wasm witness)", 280.0 - ww + wn, ww);
    Ok(())
}
