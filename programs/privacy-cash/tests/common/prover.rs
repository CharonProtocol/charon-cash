use anyhow::{anyhow, Result};
use ark_bn254::Fr;
use ark_bn254::{Bn254, Fq, Fq2, G1Affine, G2Affine};
use ark_circom::circom::CircomReduction;
use ark_circom::{read_zkey, WitnessCalculator};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, Proof};
use ark_std::{rand::thread_rng, UniformRand};
use num_bigint::{BigInt, BigUint, Sign};
use once_cell::sync::Lazy;
use solana_sdk::bs58;
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;
use std::{fs::File, path::Path};
use wasmer::Store;

static PROVER_CACHE: Lazy<
    Mutex<
        HashMap<
            PathBuf,
            (
                ark_groth16::ProvingKey<Bn254>,
                ark_circom::index::NPIndex<Fr>,
            ),
        >,
    >,
> = Lazy::new(|| Mutex::new(HashMap::new()));

use crate::common::constants::FIELD_SIZE_DECIMAL;
use crate::common::utils::get_mint_address_field;

/// BN254 base field modulus used for sign-bit logic, matching the TS implementation.
static FIELD_SIZE: Lazy<BigUint> = Lazy::new(|| {
    BigUint::parse_bytes(
        b"21888242871839275222246405745257275088548364400416034343698204186575808495617",
        10,
    )
    .expect("valid BN254 modulus")
});

#[derive(Debug, Clone)]
pub struct ProofInput {
    pub root: [u8; 32],
    pub input_nullifier: [[u8; 32]; 2],
    pub output_commitment: [[u8; 32]; 2],

    pub public_amount: BigUint,
    pub ext_data_hash: [u8; 32],

    pub in_amount: Vec<BigUint>,
    pub in_private_key: Vec<BigUint>,
    pub in_blinding: Vec<BigUint>,

    pub mint_address: String,

    pub in_path_indices: [usize; 2],
    pub in_path_elements: Vec<Vec<[u8; 32]>>,

    pub out_amount: Vec<BigUint>,
    pub out_blinding: Vec<BigUint>,
    pub out_pubkey: Vec<BigUint>,
}

#[derive(Debug, Clone)]
pub struct DepositProofArtifacts {
    pub proof: Proof<Bn254>,
    pub public_inputs: Vec<Fr>,
}

#[derive(Debug, Clone)]
pub struct ProofBytes {
    pub proof_a: Vec<u8>,
    pub proof_b: Vec<u8>,
    pub proof_c: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct DepositProofToSubmit {
    pub proof_a: Vec<u8>,
    pub proof_b: Vec<u8>,
    pub proof_c: Vec<u8>,

    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],

    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
}

/// Prove using Circom WASM witness generation + SnarkJS `.zkey`.
pub fn prove(input: &ProofInput, key_base_path: &Path) -> Result<DepositProofArtifacts> {
    let wasm_path = key_base_path.with_extension("wasm");
    let zkey_path = key_base_path.with_extension("zkey");

    // 1) Run the Circom-generated witness calculator from WASM.
    let mut store = Store::default();
    let mut wc = WitnessCalculator::new(&mut store, &wasm_path).map_err(anyhow::Error::msg)?;

    let inputs = build_circom_inputs(input)?;
    let witness: Vec<Fr> = wc
        .calculate_witness_element::<Fr, _>(&mut store, inputs, true)
        .map_err(anyhow::Error::msg)?;

    // 2) Load the exact SnarkJS zkey.
    let mut cache_guard = PROVER_CACHE.lock().unwrap();
    if !cache_guard.contains_key(key_base_path) {
        let mut zkey_file = File::open(&zkey_path)
            .map_err(|e| anyhow!("cannot open zkey {}: {e}", zkey_path.display()))?;
        let (pk, np_index) = read_zkey(&mut zkey_file)?;
        cache_guard.insert(key_base_path.to_path_buf(), (pk, np_index));
    }
    let (pk, np_index) = cache_guard.get(key_base_path).unwrap();

    // 3) Prove using the witness + matrices from the zkey.
    let mut rng = thread_rng();
    let r = Fr::rand(&mut rng);
    let s = Fr::rand(&mut rng);

    let mut matrices = Vec::new();
    matrices.push(np_index.a.clone());
    matrices.push(np_index.b.clone());
    matrices.push(np_index.c.clone());

    let proof = Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
        pk,
        r,
        s,
        &matrices,
        np_index.num_instance_variables,
        np_index.num_constraints,
        &witness,
    )?;

    // snarkjs publicSignals excludes the leading constant 1.
    if np_index.num_instance_variables == 0 {
        return Err(anyhow!("invalid zkey: num_instance_variables is zero"));
    }
    let public_input_count = np_index.num_instance_variables - 1;

    if witness.len() < np_index.num_instance_variables {
        return Err(anyhow!(
            "witness too short: got {}, need at least {}",
            witness.len(),
            np_index.num_instance_variables
        ));
    }

    let public_inputs = witness[1..1 + public_input_count].to_vec();

    let prepared_verifying_key = prepare_verifying_key(&pk.vk);
    let ok = ark_groth16::Groth16::<Bn254>::verify_proof(
        &prepared_verifying_key,
        &proof,
        &public_inputs,
    )
    .unwrap();
    println!("native verify: {ok}");
    Ok(DepositProofArtifacts {
        proof,
        public_inputs,
    })
}

/// Convert the proof + public inputs into the exact submit shape used by your TS code.
pub fn deposit_artifacts_to_submit(
    artifacts: &DepositProofArtifacts,
    compressed: bool,
) -> Result<DepositProofToSubmit> {
    let proof_bytes = proof_to_bytes(&artifacts.proof, compressed);
    let public_inputs_bytes = public_inputs_to_bytes(&artifacts.public_inputs);

    if public_inputs_bytes.len() < 7 {
        return Err(anyhow!(
            "expected at least 7 public inputs, got {}",
            public_inputs_bytes.len()
        ));
    }

    Ok(DepositProofToSubmit {
        proof_a: proof_bytes.proof_a,
        proof_b: proof_bytes.proof_b,
        proof_c: proof_bytes.proof_c,

        root: public_inputs_bytes[0],
        public_amount: public_inputs_bytes[1],
        ext_data_hash: public_inputs_bytes[2],
        input_nullifiers: [public_inputs_bytes[3], public_inputs_bytes[4]],
        output_commitments: [public_inputs_bytes[5], public_inputs_bytes[6]],
    })
}

/// Mirrors your TS `parseProofToBytesArray()` behavior.
pub fn proof_to_bytes(proof: &Proof<Bn254>, compressed: bool) -> ProofBytes {
    ProofBytes {
        proof_a: serialize_g1(&proof.a, compressed, true), // TS proofA uses inverted sign handling
        proof_b: serialize_g2(&proof.b, compressed),
        proof_c: serialize_g1(&proof.c, compressed, false), // TS proofC uses natural sign handling
    }
}

/// Mirrors your TS `parseToBytesArray()`.
pub fn public_inputs_to_bytes(public_inputs: &[Fr]) -> Vec<[u8; 32]> {
    public_inputs.iter().map(fr_to_be_bytes_32).collect()
}

fn build_circom_inputs(input: &ProofInput) -> Result<Vec<(String, Vec<BigInt>)>> {
    Ok(vec![
        ("root".to_string(), vec![bytes32_to_bigint(&input.root)]),
        (
            "inputNullifier".to_string(),
            input
                .input_nullifier
                .iter()
                .map(bytes32_to_bigint)
                .collect(),
        ),
        (
            "outputCommitment".to_string(),
            input
                .output_commitment
                .iter()
                .map(bytes32_to_bigint)
                .collect(),
        ),
        (
            "publicAmount".to_string(),
            vec![biguint_to_bigint(&input.public_amount)],
        ),
        (
            "extDataHash".to_string(),
            vec![bytes32_to_bigint_le(&input.ext_data_hash)],
        ),
        (
            "inAmount".to_string(),
            input.in_amount.iter().map(biguint_to_bigint).collect(),
        ),
        (
            "inPrivateKey".to_string(),
            input.in_private_key.iter().map(biguint_to_bigint).collect(),
        ),
        (
            "inBlinding".to_string(),
            input.in_blinding.iter().map(biguint_to_bigint).collect(),
        ),
        (
            "mintAddress".to_string(),
            vec![{
                let mint_field_str = get_mint_address_field(&input.mint_address);
                // mint_field_str is now a decimal string (or, for the placeholder, still base58 — see note below)
                string_to_bigint(&mint_field_str)?
            }],
        ),
        (
            "inPathIndices".to_string(),
            input
                .in_path_indices
                .iter()
                .copied()
                .map(BigInt::from)
                .collect(),
        ),
        (
            "inPathElements".to_string(),
            input
                .in_path_elements
                .iter()
                .flatten()
                .map(bytes32_to_bigint)
                .collect(),
        ),
        (
            "outAmount".to_string(),
            input.out_amount.iter().map(biguint_to_bigint).collect(),
        ),
        (
            "outBlinding".to_string(),
            input.out_blinding.iter().map(biguint_to_bigint).collect(),
        ),
        (
            "outPubkey".to_string(),
            input.out_pubkey.iter().map(biguint_to_bigint).collect(),
        ),
    ])
}

fn bytes32_to_bigint(bytes: &[u8; 32]) -> BigInt {
    BigInt::from(BigUint::from_bytes_be(bytes))
}

fn bytes32_to_bigint_le(bytes: &[u8; 32]) -> BigInt {
    BigInt::from(BigUint::from_bytes_le(bytes))
}

fn biguint_to_bigint(v: &BigUint) -> BigInt {
    BigInt::from(v.clone())
}

fn string_to_bigint(value: &str) -> Result<BigInt> {
    // If every character is a decimal digit, parse as base 10.
    if value.chars().all(|c| c.is_ascii_digit()) {
        return BigInt::parse_bytes(value.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid decimal integer"));
    }

    // Otherwise treat it as a Base58-encoded Solana key.
    let bytes = bs58::decode(value)
        .into_vec()
        .map_err(|e| anyhow!("invalid base58 string: {e}"))?;

    let raw = BigInt::from_bytes_be(Sign::Plus, &bytes);
    Ok(raw)
}
pub fn string_to_biguint(value: &str) -> Result<BigUint> {
    // If every character is a decimal digit, parse as base 10.
    if value.chars().all(|c| c.is_ascii_digit()) {
        return BigUint::parse_bytes(value.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid decimal integer"));
    }

    // Otherwise treat it as a Base58-encoded Solana key.
    let bytes = bs58::decode(value)
        .into_vec()
        .map_err(|e| anyhow!("invalid base58 string: {e}"))?;

    let raw: BigUint = BigUint::from_bytes_be(&bytes);
    let field_size = BigUint::from_str(FIELD_SIZE_DECIMAL).unwrap();
    Ok(raw % &field_size)
}

fn parse_bigint_vec(values: &[String]) -> Result<Vec<BigInt>> {
    values.iter().map(|v| parse_bigint(v)).collect()
}

fn parse_bigint(value: &str) -> Result<BigInt> {
    BigInt::parse_bytes(value.as_bytes(), 10)
        .ok_or_else(|| anyhow!("invalid decimal field element: {value}"))
}

fn fr_to_be_bytes_32(x: &Fr) -> [u8; 32] {
    prime_field_to_be_bytes_32(x)
}

fn fq_to_be_bytes_32(x: &Fq) -> [u8; 32] {
    prime_field_to_be_bytes_32(x)
}

fn prime_field_to_be_bytes_32<F: PrimeField>(x: &F) -> [u8; 32] {
    let le = x.into_bigint().to_bytes_le();
    let mut out = [0u8; 32];

    for (i, b) in le.iter().enumerate().take(32) {
        out[31 - i] = *b;
    }

    out
}

fn fq_to_biguint(x: &Fq) -> BigUint {
    BigUint::from_bytes_le(&x.into_bigint().to_bytes_le())
}

fn y_is_positive_g1(y: &Fq) -> bool {
    let midpoint = &*FIELD_SIZE / 2u32;
    fq_to_biguint(y) <= midpoint
}

fn y_is_positive_g2(y: &Fq2) -> bool {
    // This matches the TS logic for proofB:
    // first compare the first 32-byte limb, then the second.
    let midpoint = &*FIELD_SIZE / 2u32;

    let y0 = fq_to_biguint(&y.c0);
    let y1 = fq_to_biguint(&y.c1);

    if y0 < midpoint {
        true
    } else if y0 > midpoint {
        false
    } else {
        y1 < midpoint
    }
}

fn add_bitmask_to_first_byte(bytes: &mut [u8], y_is_positive: bool) {
    if !y_is_positive {
        bytes[0] |= 1 << 7;
    }
}

/// G1 serialization matching TS:
/// - uncompressed: x_be || y_be
/// - compressed: x_be with sign bit, where `invert_sign` controls the proofA special case
fn serialize_g1(p: &G1Affine, compressed: bool, invert_sign: bool) -> Vec<u8> {
    let mut x = fq_to_be_bytes_32(&p.x);

    if compressed {
        let y_is_positive = y_is_positive_g1(&p.y);
        let effective_positive = if invert_sign {
            !y_is_positive
        } else {
            y_is_positive
        };

        add_bitmask_to_first_byte(&mut x, effective_positive);
        return x.to_vec();
    }

    let y = fq_to_be_bytes_32(&p.y);
    [x.as_slice(), y.as_slice()].concat()
}

/// G2 serialization matching TS:
/// - uncompressed: x.c0_be || x.c1_be || y.c0_be || y.c1_be
/// - compressed: x.c0_be || x.c1_be with sign bit on the first byte
fn serialize_g2(p: &G2Affine, compressed: bool) -> Vec<u8> {
    let x0 = fq_to_be_bytes_32(&p.x.c0);
    let x1 = fq_to_be_bytes_32(&p.x.c1);
    let y0 = fq_to_be_bytes_32(&p.y.c0);
    let y1 = fq_to_be_bytes_32(&p.y.c1);

    let mut out = Vec::with_capacity(if compressed { 64 } else { 128 });
    out.extend_from_slice(&x1);
    out.extend_from_slice(&x0);

    if compressed {
        add_bitmask_to_first_byte(&mut out, y_is_positive_g2(&p.y));
        return out;
    }

    out.extend_from_slice(&y1);
    out.extend_from_slice(&y0);
    out
}
