use num_bigint::BigUint;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::path::Path;

const FIELD_SIZE_DECIMAL: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProofJson {
    pub pi_a: [String; 2],
    pub pi_b: [[String; 2]; 2],
    pub pi_c: [String; 2],
    pub protocol: String,
    pub curve: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProofFixture {
    pub proof: ProofJson,
    pub public_signals: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VerificationKeyFixture {
    pub vk: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofBytes {
    pub proof_a: Vec<u8>,
    pub proof_b: Vec<u8>,
    pub proof_c: Vec<u8>,
}

#[derive(Debug)]
pub enum ProverError {
    Unsupported(&'static str),
    InvalidDecimal(String),
    TooLarge(&'static str),
    Json(serde_json::Error),
    Io(std::io::Error),
}

impl fmt::Display for ProverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProverError::Unsupported(msg) => write!(f, "{msg}"),
            ProverError::InvalidDecimal(s) => write!(f, "invalid decimal string: {s}"),
            ProverError::TooLarge(what) => write!(f, "{what} does not fit into 32 bytes"),
            ProverError::Json(e) => write!(f, "{e}"),
            ProverError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ProverError {}

impl From<serde_json::Error> for ProverError {
    fn from(value: serde_json::Error) -> Self {
        ProverError::Json(value)
    }
}

impl From<std::io::Error> for ProverError {
    fn from(value: std::io::Error) -> Self {
        ProverError::Io(value)
    }
}

pub fn prove_fixture_only(input: Value) -> Value {
    input
}

pub fn load_proof_fixture(json: &str) -> Result<ProofFixture, ProverError> {
    Ok(serde_json::from_str(json)?)
}

pub fn prove(_input: Value, _key_base_path: impl AsRef<Path>) -> Result<(ProofJson, Vec<String>), ProverError> {
    Err(ProverError::Unsupported(
        "snarkjs proving is not implemented in pure Rust; use the external Node/CLI path",
    ))
}

pub fn prove_zkutil(_input: Value, _key_base_path: impl AsRef<Path>) -> Result<String, ProverError> {
    Err(ProverError::Unsupported(
        "zkutil proving is not implemented in pure Rust; use the external CLI path",
    ))
}

pub fn verify(
    _verification_key_path: impl AsRef<Path>,
    _public_signals: &[String],
    _proof: &ProofJson,
) -> Result<bool, ProverError> {
    Err(ProverError::Unsupported(
        "groth16 verification wrapper is not implemented in pure Rust; use the external verifier path",
    ))
}

pub fn parse_proof_to_bytes_array(
    proof: &ProofJson,
    compressed: bool,
) -> Result<ProofBytes, ProverError> {
    // Faithful port of the TS behavior:
    // - pi_a and pi_c: each scalar -> 32-byte LE, then reversed to BE
    // - pi_b: each scalar -> 32-byte LE; rows are flattened, then the whole row is reversed
    // - compressed mode:
    //   - proofA = row A bytes + sign bit
    //   - proofB = ONLY pi_b[0] row bytes + sign bit
    //   - proofC = row C bytes + sign bit
    let a0 = be32_from_decimal(&proof.pi_a[0])?;
    let a1 = be32_from_decimal(&proof.pi_a[1])?;
    let c0 = be32_from_decimal(&proof.pi_c[0])?;
    let c1 = be32_from_decimal(&proof.pi_c[1])?;

    let b00_le = le32_from_decimal(&proof.pi_b[0][0])?;
    let b01_le = le32_from_decimal(&proof.pi_b[0][1])?;
    let b10_le = le32_from_decimal(&proof.pi_b[1][0])?;
    let b11_le = le32_from_decimal(&proof.pi_b[1][1])?;

    let y_a = decimal_to_biguint(&proof.pi_a[1])?;
    let y_c = decimal_to_biguint(&proof.pi_c[1])?;
    let y_b0 = decimal_to_biguint(&proof.pi_b[1][0])?;
    let y_b1 = decimal_to_biguint(&proof.pi_b[1][1])?;

    if compressed {
        let mut proof_a = vec![a0[0], a0[1], a0[2], a0[3], a0[4], a0[5], a0[6], a0[7],
                               a0[8], a0[9], a0[10], a0[11], a0[12], a0[13], a0[14], a0[15],
                               a0[16], a0[17], a0[18], a0[19], a0[20], a0[21], a0[22], a0[23],
                               a0[24], a0[25], a0[26], a0[27], a0[28], a0[29], a0[30], a0[31]];
        let proof_a_is_positive = !y_element_is_positive_g1(&y_a);
        proof_a[0] = add_bitmask_to_byte(proof_a[0], proof_a_is_positive);

        let mut proof_b = row_b_bytes_reversed(&[b00_le, b01_le]);
        let proof_b_is_positive = y_element_is_positive_g2(&y_b0, &y_b1);
        proof_b[0] = add_bitmask_to_byte(proof_b[0], proof_b_is_positive);

        let mut proof_c = vec![c0[0], c0[1], c0[2], c0[3], c0[4], c0[5], c0[6], c0[7],
                               c0[8], c0[9], c0[10], c0[11], c0[12], c0[13], c0[14], c0[15],
                               c0[16], c0[17], c0[18], c0[19], c0[20], c0[21], c0[22], c0[23],
                               c0[24], c0[25], c0[26], c0[27], c0[28], c0[29], c0[30], c0[31]];
        let proof_c_is_positive = y_element_is_positive_g1(&y_c);
        proof_c[0] = add_bitmask_to_byte(proof_c[0], proof_c_is_positive);

        Ok(ProofBytes {
            proof_a,
            proof_b,
            proof_c,
        })
    } else {
        let mut proof_a = Vec::with_capacity(64);
        proof_a.extend_from_slice(&a0);
        proof_a.extend_from_slice(&a1);

        let mut proof_b = row_b_bytes_reversed(&[b00_le, b01_le]);
        let mut proof_b_1 = row_b_bytes_reversed(&[b10_le, b11_le]);
        proof_b.append(&mut proof_b_1);

        let mut proof_c = Vec::with_capacity(64);
        proof_c.extend_from_slice(&c0);
        proof_c.extend_from_slice(&c1);

        Ok(ProofBytes {
            proof_a,
            proof_b,
            proof_c,
        })
    }
}

pub fn parse_to_bytes_array(public_signals: &[String]) -> Result<Vec<[u8; 32]>, ProverError> {
    public_signals
        .iter()
        .map(|s| be32_from_decimal(s))
        .collect()
}

fn decimal_to_biguint(decimal: &str) -> Result<BigUint, ProverError> {
    BigUint::parse_bytes(decimal.as_bytes(), 10)
        .ok_or_else(|| ProverError::InvalidDecimal(decimal.to_string()))
}

fn modulus() -> BigUint {
    BigUint::parse_bytes(FIELD_SIZE_DECIMAL.as_bytes(), 10).expect("valid field modulus")
}

fn be32_from_decimal(decimal: &str) -> Result<[u8; 32], ProverError> {
    let n = decimal_to_biguint(decimal)?;
    let bytes = n.to_bytes_be();
    if bytes.len() > 32 {
        return Err(ProverError::TooLarge("field element"));
    }
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(out)
}

fn le32_from_decimal(decimal: &str) -> Result<[u8; 32], ProverError> {
    let n = decimal_to_biguint(decimal)?;
    let bytes = n.to_bytes_le();
    if bytes.len() > 32 {
        return Err(ProverError::TooLarge("field element"));
    }
    let mut out = [0u8; 32];
    out[..bytes.len()].copy_from_slice(&bytes);
    Ok(out)
}

fn row_b_bytes_reversed(row: &[[u8; 32]; 2]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&row[0]);
    out.extend_from_slice(&row[1]);
    out.reverse();
    out
}

fn y_element_is_positive_g1(y: &BigUint) -> bool {
    // Faithful to:
    // yElement.lte(FIELD_SIZE.sub(yElement))
    // i.e. 2y <= p
    let p = modulus();
    let two_y = y << 1usize;
    two_y <= p
}

fn y_element_is_positive_g2(y1: &BigUint, y2: &BigUint) -> bool {
    let p = modulus();
    let midpoint = &p >> 1usize;

    if y1 < &midpoint {
        true
    } else if y1 > &midpoint {
        false
    } else {
        y2 < &midpoint
    }
}

fn add_bitmask_to_byte(byte: u8, y_is_positive: bool) -> u8 {
    if !y_is_positive {
        byte | (1 << 7)
    } else {
        byte
    }
}