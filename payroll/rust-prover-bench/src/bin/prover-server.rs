// Persistent arkworks prover: loads the zkey + witness wasm once, then proves
// one circuit input per stdin JSON line, replying with a snarkjs-format proof.
// Line protocol: {"id":N,"input":{...}} -> {"id":N,"ok":true,"proof":{...},"publicSignals":[...]}

use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};

use ark_bn254::{Bn254, Fq2, Fr, G1Affine, G2Affine};
use ark_circom::{read_zkey, CircomBuilder, CircomConfig, CircomReduction};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Groth16;
use ark_snark::SNARK;
use ark_std::rand::thread_rng;
use num_bigint::{BigInt, BigUint};
use serde_json::{json, Value};

const DEFAULT_CIRCUIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../programs/privacy-cash/artifacts/circuits/transaction2");

fn flatten(v: &Value, out: &mut Vec<BigInt>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| flatten(x, out)),
        Value::String(s) => {
            let t = s.trim_start_matches("0x");
            let v = BigInt::parse_bytes(t.as_bytes(), 10)
                .or_else(|| BigInt::parse_bytes(t.as_bytes(), 16));
            out.push(v.unwrap());
        }
        Value::Number(n) => out.push(BigInt::parse_bytes(n.to_string().as_bytes(), 10).unwrap()),
        Value::Object(map) => {
            if let Some(data) = map.get("data").and_then(|d| d.as_array()) {
                let bytes: Vec<u8> = data.iter().map(|x| x.as_u64().unwrap() as u8).collect();
                out.push(BigUint::from_bytes_le(&bytes).into());
            } else if map.contains_key("0") {
                // JSON.stringify'd typed arrays land as {"0":v,"1":v,...}
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

fn fp_dec<F: PrimeField>(f: &F) -> String {
    BigUint::from_bytes_le(&f.into_bigint().to_bytes_le()).to_string()
}

fn g1_json(p: &G1Affine) -> Value {
    let (x, y) = p.xy().expect("point at infinity");
    json!([fp_dec(&x), fp_dec(&y), "1"])
}

fn fp2_pair(e: &Fq2, swap: bool) -> Value {
    if swap {
        json!([fp_dec(&e.c1), fp_dec(&e.c0)])
    } else {
        json!([fp_dec(&e.c0), fp_dec(&e.c1)])
    }
}

fn g2_json(p: &G2Affine, swap: bool) -> Value {
    let (x, y) = p.xy().expect("point at infinity");
    json!([fp2_pair(&x, swap), fp2_pair(&y, swap), json!(["1", "0"])])
}

fn main() -> color_eyre::Result<()> {
    color_eyre::install()?;

    let threads: usize = env::var("ARK_THREADS").ok().and_then(|s| s.parse().ok()).unwrap_or(1);
    rayon::ThreadPoolBuilder::new().num_threads(threads).build_global()?;
    let g2_swap = env::var("ARK_G2").as_deref() == Ok("c1c0");
    let circuit = env::var("ARK_CIRCUIT").unwrap_or_else(|_| DEFAULT_CIRCUIT.to_string());
    eprintln!("circuit             {circuit}");

    let t = std::time::Instant::now();
    let mut zr = File::open(format!("{circuit}.zkey"))?;
    let (pk, _np) = read_zkey(&mut zr)?;
    eprintln!("zkey load           {:>9.2?}   (threads={threads}, g2_swap={g2_swap})", t.elapsed());

    let t = std::time::Instant::now();
    let cfg = CircomConfig::<Fr>::new(format!("{circuit}.wasm"), format!("{circuit}.r1cs"))?;
    eprintln!("r1cs+wasm load      {:>9.2?}", t.elapsed());

    let mut builder = CircomBuilder::<Fr>::new(cfg);

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, r#"{{"ready":true}}"#)?;
    out.flush()?;

    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                writeln!(out, r#"{{"ok":false,"error":"bad request: {e}"}}"#)?;
                out.flush()?;
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let t = std::time::Instant::now();
        let resp = match req.get("input").and_then(|i| i.as_object()) {
            Some(input) => (|| -> color_eyre::Result<Value> {
                let mut inputs = HashMap::new();
                for (k, v) in input {
                    let mut flat = Vec::new();
                    flatten(v, &mut flat);
                    inputs.insert(k.clone(), flat);
                }
                let mut circuit = builder.setup();
                let witness = builder.cfg.wtns.calculate_witness_element::<Fr, _>(
                    &mut builder.cfg.store,
                    inputs,
                    builder.cfg.sanity_check,
                )?;
                circuit.witness = Some(witness);
                let pubs = circuit.get_public_inputs().ok_or_else(|| color_eyre::Report::msg("no witness for public inputs"))?;
                let proof = Groth16::<Bn254, CircomReduction>::prove(&pk, circuit, &mut thread_rng())?;
                if !Groth16::<Bn254, CircomReduction>::verify(&pk.vk, &pubs, &proof)? {
                    if let Some(path) = env::var("ARK_BAD_INPUTS").ok() {
                        let _ = std::fs::OpenOptions::new().create(true).append(true)
                            .open(&path)
                            .and_then(|mut f| writeln!(f, "{}", serde_json::to_string(&req)?));
                    }
                    return Err(color_eyre::Report::msg("self-verify failed (witness does not satisfy constraints)"));
                }
                Ok(json!({
                    "id": id,
                    "ok": true,
                    "witnessMs": t.elapsed().as_millis() as u64,
                    "proof": {
                        "pi_a": g1_json(&proof.a),
                        "pi_b": g2_json(&proof.b, g2_swap),
                        "pi_c": g1_json(&proof.c),
                        "protocol": "groth16",
                        "curve": "bn128",
                    },
                    "publicSignals": pubs.iter().map(|p| fp_dec(p)).collect::<Vec<_>>(),
                }))
            })()
            .unwrap_or_else(|e| json!({"id": id, "ok": false, "error": e.to_string()})),
            None => json!({"id": id, "ok": false, "error": "missing input"}),
        };
        writeln!(out, "{}", serde_json::to_string(&resp)?)?;
        out.flush()?;
    }
    Ok(())
}
