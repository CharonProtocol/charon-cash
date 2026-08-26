use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::time::Instant;

use ark_bn254::{Bn254, Fr};
use ark_circom::{read_zkey, CircomBuilder, CircomCircuit, CircomConfig, CircomReduction};
use ark_groth16::Groth16;
use ark_snark::SNARK;
use ark_std::rand::thread_rng;
use color_eyre::Result;
use num_bigint::{BigInt, BigUint};

const CIRCUIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../programs/privacy-cash/artifacts/circuits/transaction2");
const WTNS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/witness.wtns");
const INPUT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/input.json");

fn read_wtns(path: &str) -> Result<Vec<Fr>> {
    let mut b = Vec::new();
    File::open(path)?.read_to_end(&mut b)?;
    let rd32 = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let rd64 = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    assert_eq!(rd32(0), 0x736e_7477, "not a wtns file");

    let n_sections = rd32(8) as usize;
    let mut off = 12;
    let (mut n8, mut nw, mut data_off) = (0usize, 0usize, 0usize);
    for _ in 0..n_sections {
        let ty = rd32(off) as usize;
        let size = rd64(off + 4) as usize;
        let body = off + 12;
        if ty == 1 {
            n8 = rd32(body) as usize;
            nw = rd32(body + 4 + n8) as usize;
        } else {
            data_off = body;
        }
        off = body + size;
    }

    let values = (0..nw)
        .map(|i| {
            let s = data_off + i * n8;
            Fr::from(BigUint::from_bytes_le(&b[s..s + n8]))
        })
        .collect();
    Ok(values)
}

fn flatten(v: &serde_json::Value, out: &mut Vec<BigInt>) {
    match v {
        serde_json::Value::Array(items) => items.iter().for_each(|x| flatten(x, out)),
        serde_json::Value::String(s) => {
            let t = s.trim_start_matches("0x");
            let v = BigInt::parse_bytes(t.as_bytes(), 10)
                .or_else(|| BigInt::parse_bytes(t.as_bytes(), 16));
            out.push(v.unwrap());
        }
        serde_json::Value::Number(n) => out.push(BigInt::parse_bytes(n.to_string().as_bytes(), 10).unwrap()),
        serde_json::Value::Object(map) => {
            let bytes: Vec<u8> = map["data"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u8).collect();
            out.push(BigUint::from_bytes_le(&bytes).into());
        }
        other => panic!("unsupported input value {other}"),
    }
}

fn main() -> Result<()> {
    color_eyre::install()?;

    let t = Instant::now();
    let mut zr = File::open(format!("{CIRCUIT}.zkey"))?;
    let (pk, np) = read_zkey(&mut zr)?;
    println!(
        "zkey load           {:>9.2?}   ({} constraints, {} public)",
        t.elapsed(),
        np.num_constraints,
        np.num_instance_variables - 1
    );

    let t = Instant::now();
    let cfg = CircomConfig::<Fr>::new(format!("{CIRCUIT}.wasm"), format!("{CIRCUIT}.r1cs"))?;
    println!(
        "r1cs+wasm load      {:>9.2?}   (inputs {}, aux {})",
        t.elapsed(),
        cfg.r1cs.num_inputs,
        cfg.r1cs.num_aux
    );

    let t = Instant::now();
    let wtns = read_wtns(WTNS)?;
    println!("wtns load           {:>9.2?}   ({} values)", t.elapsed(), wtns.len());

    let iters: usize = std::env::args().nth(1).map(|s| s.parse().unwrap()).unwrap_or(3);

    let mut r1cs = cfg.r1cs.clone();
    r1cs.wire_mapping = None;
    let circuit = CircomCircuit { r1cs, witness: Some(wtns) };
    let pub_inputs = circuit.get_public_inputs().unwrap();
    println!("public signals      {:?}", pub_inputs);

    for i in 0..iters {
        let t = Instant::now();
        let proof = Groth16::<Bn254, CircomReduction>::prove(&pk, circuit.clone(), &mut thread_rng())?;
        let d = t.elapsed();
        let ok = Groth16::<Bn254, CircomReduction>::verify(&pk.vk, &pub_inputs, &proof)?;
        println!("rust prove [{i}]     {:>9.2?}   verify: {ok}", d);
    }

    let raw: serde_json::Value = serde_json::from_reader(File::open(INPUT)?)?;
    let mut inputs = HashMap::new();
    if let serde_json::Value::Object(map) = raw {
        for (k, v) in map {
            let mut flat = Vec::new();
            flatten(&v, &mut flat);
            inputs.insert(k, flat);
        }
    }
    let mut builder = CircomBuilder::<Fr>::new(cfg);
    builder.inputs = inputs;
    let t = Instant::now();
    let circuit2 = builder.build()?;
    let wit = t.elapsed();
    let pub2 = circuit2.get_public_inputs().unwrap();
    let t = Instant::now();
    let proof2 = Groth16::<Bn254, CircomReduction>::prove(&pk, circuit2, &mut thread_rng())?;
    let pr = t.elapsed();
    let ok2 = Groth16::<Bn254, CircomReduction>::verify(&pk.vk, &pub2, &proof2)?;
    println!("rust witness (wasmer) {:>7.2?}  verify: {ok2}", wit);
    println!("rust prove (after wasmer witness) {:>7.2?}  verify: {ok2}", pr);

    Ok(())
}
