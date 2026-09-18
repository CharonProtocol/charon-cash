use anyhow::{anyhow, Result};
use ark_bn254::Fr;
use ark_bn254::{Bn254, G1Affine, G2Affine};
use ark_circom::circom::CircomReduction;
use ark_circom::{read_zkey, WitnessCalculator};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::{prepare_verifying_key, Groth16, Proof};
use ark_serialize::CanonicalSerialize;
use ark_std::{rand::thread_rng, UniformRand};
use num_bigint::{BigInt, BigUint, Sign};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::{fs::File};
use wasmer::Store;

pub const FIELD_SIZE_DECIMAL: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedProveResponse {
    pub proof_a: String,
    pub proof_b: String,
    pub proof_c: String,
    pub public_signals: Vec<String>,
}

struct LoadedProver {
    pk: ark_groth16::ProvingKey<Bn254>,
    matrices: ark_circom::index::NPIndex<Fr>,
    zkey_path: PathBuf,
    store: Store,
    wc: WitnessCalculator,
}

static CACHE: Mutex<Option<LoadedProver>> = Mutex::new(None);

pub fn default_circuit_base() -> PathBuf {
    if let Ok(p) = std::env::var("CIRCUIT_BASE") {
        return PathBuf::from(p);
    }
    let from_crate = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../programs/privacy-cash/artifacts/circuits/transaction2");
    if from_crate.with_extension("zkey").exists() {
        return from_crate;
    }
    PathBuf::from("programs/privacy-cash/artifacts/circuits/transaction2")
}

pub fn prove(input: &ProofInput, key_base_path: &Path) -> Result<DepositProofArtifacts> {
    let wasm_path = key_base_path.with_extension("wasm");
    let zkey_path = key_base_path.with_extension("zkey");

    let mut cache = CACHE
        .lock()
        .map_err(|_| anyhow!("prover cache poisoned"))?;
    if cache
        .as_ref()
        .map(|c| c.zkey_path != zkey_path)
        .unwrap_or(true)
    {
        *cache = Some(load_prover(&wasm_path, &zkey_path)?);
    }
    let loaded = cache.as_mut().expect("prover loaded");

    // Fresh WitnessCalculator + Store per proof. Reusing one WC across
    // calculate_witness calls (and rebuilding WC from a cached Module) both
    // produced unverifiable proofs (`native groth16 verify failed`).
    let mut store = Store::default();
    let mut wc = WitnessCalculator::new(&mut store, &wasm_path).map_err(anyhow::Error::msg)?;
    let inputs = build_circom_inputs(input)?;
    let witness: Vec<Fr> = wc
        .calculate_witness_element::<Fr, _>(&mut store, inputs, true)
        .map_err(anyhow::Error::msg)?;

    let mut rng = thread_rng();
    let r = Fr::rand(&mut rng);
    let s = Fr::rand(&mut rng);

    let proof = Groth16::<Bn254, CircomReduction>::create_proof_with_reduction_and_matrices(
        &loaded.pk,
        r,
        s,
        &[
            loaded.matrices.a.clone(),
            loaded.matrices.b.clone(),
            loaded.matrices.c.clone(),
        ],
        loaded.matrices.num_instance_variables,
        loaded.matrices.num_constraints,
        &witness,
    )?;

    if loaded.matrices.num_instance_variables == 0 {
        return Err(anyhow!("invalid zkey: num_instance_variables is zero"));
    }
    let public_input_count = loaded.matrices.num_instance_variables - 1;
    if witness.len() < loaded.matrices.num_instance_variables {
        return Err(anyhow!(
            "witness too short: got {}, need at least {}",
            witness.len(),
            loaded.matrices.num_instance_variables
        ));
    }
    let public_inputs = witness[1..1 + public_input_count].to_vec();

    let prepared_verifying_key = prepare_verifying_key(&loaded.pk.vk);
    let ok = ark_groth16::Groth16::<Bn254>::verify_proof(
        &prepared_verifying_key,
        &proof,
        &public_inputs,
    )
    .unwrap_or(false);
    if !ok {
        return Err(anyhow!("native groth16 verify failed"));
    }

    Ok(DepositProofArtifacts {
        proof,
        public_inputs,
    })
}

fn load_prover(wasm_path: &Path, zkey_path: &Path) -> Result<LoadedProver> {
    let mut zkey_file = File::open(zkey_path)
        .map_err(|e| anyhow!("cannot open zkey {}: {e}", zkey_path.display()))?;
    let (pk, np_index) = read_zkey(&mut zkey_file)?;

    let mut store = Store::default();
    let wc = WitnessCalculator::new(&mut store, wasm_path).map_err(anyhow::Error::msg)?;

    Ok(LoadedProver {
        pk,
        matrices: np_index,
        zkey_path: zkey_path.to_path_buf(),
        store,
        wc,
    })
}

/// Always emit ark-compressed BE points (32/64/32) for the bn254 syscall.
pub fn proof_to_bytes(proof: &Proof<Bn254>) -> ProofBytes {
    ProofBytes {
        proof_a: serialize_g1(&proof.a),
        proof_b: serialize_g2(&proof.b),
        proof_c: serialize_g1(&proof.c),
    }
}

pub fn public_inputs_to_bytes(public_inputs: &[Fr]) -> Vec<[u8; 32]> {
    public_inputs.iter().map(fr_to_be_bytes_32).collect()
}

pub fn public_inputs_to_decimal(public_inputs: &[Fr]) -> Vec<String> {
    public_inputs
        .iter()
        .map(|fr| BigUint::from_bytes_be(&fr_to_be_bytes_32(fr)).to_string())
        .collect()
}

pub fn artifacts_to_response(artifacts: &DepositProofArtifacts) -> Result<CompressedProveResponse> {
    let bytes = proof_to_bytes(&artifacts.proof);
    if bytes.proof_a.len() != 32 || bytes.proof_b.len() != 64 || bytes.proof_c.len() != 32 {
        return Err(anyhow!(
            "unexpected compressed proof sizes {}/{}/{}",
            bytes.proof_a.len(),
            bytes.proof_b.len(),
            bytes.proof_c.len()
        ));
    }
    Ok(CompressedProveResponse {
        proof_a: hex::encode(&bytes.proof_a),
        proof_b: hex::encode(&bytes.proof_b),
        proof_c: hex::encode(&bytes.proof_c),
        public_signals: public_inputs_to_decimal(&artifacts.public_inputs),
    })
}

pub fn prove_circuit_json(
    value: &serde_json::Value,
    key_base_path: &Path,
) -> Result<CompressedProveResponse> {
    let input = proof_input_from_json(value)?;
    let artifacts = prove(&input, key_base_path)?;
    artifacts_to_response(&artifacts)
}

/// Matches the SDK `getMintAddressField`.
pub fn get_mint_address_field(mint: &str) -> String {
    if mint == "11111111111111111111111111111112" {
        return mint.to_string();
    }
    // Already a field element (SDK `getMintAddressField` decimal).
    if !mint.is_empty() && mint.chars().all(|c| c.is_ascii_digit()) {
        return mint.to_string();
    }
    let mint_bytes = match bs58::decode(mint).into_vec() {
        Ok(bytes) if bytes.len() >= 31 => bytes,
        _ => return mint.to_string(),
    };
    BigUint::from_bytes_be(&mint_bytes[..31]).to_string()
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
            vec![string_to_bigint(&get_mint_address_field(&input.mint_address))?],
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
    if value.chars().all(|c| c.is_ascii_digit()) {
        return BigInt::parse_bytes(value.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid decimal integer"));
    }
    let bytes = bs58::decode(value)
        .into_vec()
        .map_err(|e| anyhow!("invalid base58 string: {e}"))?;
    Ok(BigInt::from_bytes_be(Sign::Plus, &bytes))
}

fn fr_to_be_bytes_32(x: &Fr) -> [u8; 32] {
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

fn serialize_g1(p: &G1Affine) -> Vec<u8> {
    let mut le = Vec::with_capacity(32);
    p.serialize_compressed(&mut le).expect("g1 compressed");
    swap_limbs_32(&le)
}

fn serialize_g2(p: &G2Affine) -> Vec<u8> {
    let mut le = Vec::with_capacity(64);
    p.serialize_compressed(&mut le).expect("g2 compressed");
    le.iter().rev().copied().collect()
}

fn swap_limbs_32(bytes: &[u8]) -> Vec<u8> {
    bytes
        .chunks_exact(32)
        .flat_map(|chunk| chunk.iter().rev().copied())
        .collect()
}

fn json_get<'a>(v: &'a serde_json::Value, key: &str) -> Result<&'a serde_json::Value> {
    v.get(key)
        .ok_or_else(|| anyhow!("missing circuit field `{key}`"))
}

fn parse_biguint(v: &serde_json::Value) -> Result<BigUint> {
    if let Some(s) = v.as_str() {
        return parse_biguint_str(s);
    }
    if let Some(n) = v.as_u64() {
        return Ok(BigUint::from(n));
    }
    Err(anyhow!("expected decimal/hex field element, got {v}"))
}

fn parse_biguint_str(s: &str) -> Result<BigUint> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return BigUint::parse_bytes(hex.as_bytes(), 16)
            .ok_or_else(|| anyhow!("invalid hex integer"));
    }
    if s.chars().all(|c| c.is_ascii_hexdigit()) && s.len() == 64 {
        return BigUint::parse_bytes(s.as_bytes(), 16)
            .ok_or_else(|| anyhow!("invalid hex integer"));
    }
    BigUint::parse_bytes(s.as_bytes(), 10).ok_or_else(|| anyhow!("invalid decimal integer"))
}

fn pad_be(n: &BigUint) -> [u8; 32] {
    let bytes = n.to_bytes_be();
    let mut out = [0u8; 32];
    let start = 32usize.saturating_sub(bytes.len());
    out[start..].copy_from_slice(&bytes[bytes.len().saturating_sub(32)..]);
    out
}

fn parse_bytes32(v: &serde_json::Value) -> Result<[u8; 32]> {
    if let Some(s) = v.as_str() {
        let s = s.trim();
        let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")).unwrap_or(s);
        if hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            let bytes = hex::decode(hex)?;
            return bytes
                .try_into()
                .map_err(|_| anyhow!("hex field is not 32 bytes"));
        }
        return Ok(pad_be(&parse_biguint_str(s)?));
    }
    if let Some(arr) = v.as_array() {
        if arr.len() == 32 {
            let mut out = [0u8; 32];
            for (i, b) in arr.iter().enumerate() {
                out[i] = b.as_u64().ok_or_else(|| anyhow!("invalid byte"))? as u8;
            }
            return Ok(out);
        }
    }
    Ok(pad_be(&parse_biguint(v)?))
}

fn parse_vec_biguint(v: &serde_json::Value) -> Result<Vec<BigUint>> {
    let arr = v
        .as_array()
        .ok_or_else(|| anyhow!("expected array of field elements"))?;
    arr.iter().map(parse_biguint).collect()
}

fn parse_bytes32_pair(v: &serde_json::Value) -> Result<[[u8; 32]; 2]> {
    let arr = v.as_array().ok_or_else(|| anyhow!("expected length-2 array"))?;
    if arr.len() != 2 {
        return Err(anyhow!("expected 2 elements, got {}", arr.len()));
    }
    Ok([parse_bytes32(&arr[0])?, parse_bytes32(&arr[1])?])
}

fn proof_input_from_json(v: &serde_json::Value) -> Result<ProofInput> {
    let in_path_indices = {
        let arr = json_get(v, "inPathIndices")?
            .as_array()
            .ok_or_else(|| anyhow!("inPathIndices must be an array"))?;
        if arr.len() != 2 {
            return Err(anyhow!("inPathIndices must have 2 entries"));
        }
        [
            arr[0].as_u64().ok_or_else(|| anyhow!("bad path index"))? as usize,
            arr[1].as_u64().ok_or_else(|| anyhow!("bad path index"))? as usize,
        ]
    };

    let in_path_elements = {
        let arr = json_get(v, "inPathElements")?
            .as_array()
            .ok_or_else(|| anyhow!("inPathElements must be an array"))?;
        let mut out = Vec::with_capacity(arr.len());
        for path in arr {
            let nodes = path
                .as_array()
                .ok_or_else(|| anyhow!("inPathElements entries must be arrays"))?;
            let mut row = Vec::with_capacity(nodes.len());
            for node in nodes {
                row.push(parse_bytes32(node)?);
            }
            out.push(row);
        }
        out
    };

    Ok(ProofInput {
        root: parse_bytes32(json_get(v, "root")?)?,
        input_nullifier: parse_bytes32_pair(json_get(v, "inputNullifier")?)?,
        output_commitment: parse_bytes32_pair(json_get(v, "outputCommitment")?)?,
        public_amount: parse_biguint(json_get(v, "publicAmount")?)?,
        ext_data_hash: parse_bytes32(json_get(v, "extDataHash")?)?,
        in_amount: parse_vec_biguint(json_get(v, "inAmount")?)?,
        in_private_key: parse_vec_biguint(json_get(v, "inPrivateKey")?)?,
        in_blinding: parse_vec_biguint(json_get(v, "inBlinding")?)?,
        mint_address: json_get(v, "mintAddress")?
            .as_str()
            .ok_or_else(|| anyhow!("mintAddress must be a string"))?
            .to_string(),
        in_path_indices,
        in_path_elements,
        out_amount: parse_vec_biguint(json_get(v, "outAmount")?)?,
        out_blinding: parse_vec_biguint(json_get(v, "outBlinding")?)?,
        out_pubkey: parse_vec_biguint(json_get(v, "outPubkey")?)?,
    })
}

/// One JSON object per stdin line; one JSON response per stdout line.
/// Prove failures are returned as `{"error": "..."}` so the process stays up.
pub fn serve_stdio_loop() -> Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<serde_json::Value>(&line) {
            Err(e) => serde_json::json!({ "error": format!("invalid json: {e}") }),
            Ok(value) => match prove_circuit_json(&value, &default_circuit_base()) {
                Ok(response) => serde_json::to_value(&response)
                    .unwrap_or_else(|e| serde_json::json!({ "error": e.to_string() })),
                Err(e) => serde_json::json!({ "error": format!("{e:#}") }),
            },
        };
        serde_json::to_writer(&mut stdout, &reply)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::AffineRepr;
    use ark_serialize::CanonicalSerialize;

    #[test]
    fn compressed_g1_g2_sizes() {
        let a = G1Affine::identity();
        let b = G2Affine::identity();
        let proof = Proof { a, b, c: a };
        let bytes = proof_to_bytes(&proof);
        assert_eq!(bytes.proof_a.len(), 32);
        assert_eq!(bytes.proof_b.len(), 64);
        assert_eq!(bytes.proof_c.len(), 32);
    }

    #[test]
    fn g1_compressed_is_32_limb_swap() {
        let a = G1Affine::generator();
        let mut le = Vec::new();
        a.serialize_compressed(&mut le).unwrap();
        assert_eq!(serialize_g1(&a), swap_limbs_32(&le));
    }

    #[test]
    fn g2_compressed_is_full_64_byte_reverse() {
        let b = G2Affine::generator();
        let mut le = Vec::new();
        b.serialize_compressed(&mut le).unwrap();
        let expected: Vec<u8> = le.iter().rev().copied().collect();
        assert_eq!(serialize_g2(&b), expected);
        assert_eq!(serialize_g2(&b).len(), 64);
    }

    #[test]
    fn sol_mint_field_matches_sdk() {
        assert_eq!(
            get_mint_address_field("11111111111111111111111111111112"),
            "11111111111111111111111111111112"
        );
        let usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let bytes = bs58::decode(usdc).into_vec().unwrap();
        assert_eq!(
            get_mint_address_field(usdc),
            BigUint::from_bytes_be(&bytes[..31]).to_string()
        );
        let already = get_mint_address_field(usdc);
        assert_eq!(get_mint_address_field(&already), already);
    }
}
