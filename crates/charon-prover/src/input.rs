//! Circuit input: the SDK's JSON shape, the typed `ProofInput`, and the flat
//! `(signal name, values)` list the witness generator consumes.

use anyhow::{anyhow, Result};
use num_bigint::BigUint;

pub const FIELD_SIZE_DECIMAL: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

const SOL_MINT_PLACEHOLDER: &str = "11111111111111111111111111111112";

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

/// Matches the SDK `getMintAddressField`.
pub fn get_mint_address_field(mint: &str) -> String {
    if mint == SOL_MINT_PLACEHOLDER {
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

/// Circom signal name -> flattened values, in circuit declaration order.
///
/// The SDK passes `extDataHash` as the raw SHA-256 digest, first byte first.
/// The circuit signal, and the bytes stored in the proof, are that digest read
/// little-endian. On-chain `ext_data_hash_matches` does the same reversal
/// (`swab32`) before comparing, so this conversion has to stay here. Do not
/// also reverse the bytes in the SDK.
pub fn circuit_inputs(input: &ProofInput) -> Result<Vec<(String, Vec<BigUint>)>> {
    let be = |b: &[u8; 32]| BigUint::from_bytes_be(b);
    Ok(vec![
        ("root".into(), vec![be(&input.root)]),
        ("publicAmount".into(), vec![input.public_amount.clone()]),
        (
            "extDataHash".into(),
            vec![BigUint::from_bytes_le(&input.ext_data_hash)],
        ),
        (
            "mintAddress".into(),
            vec![mint_to_biguint(&input.mint_address)?],
        ),
        (
            "inputNullifier".into(),
            input.input_nullifier.iter().map(be).collect(),
        ),
        ("inAmount".into(), input.in_amount.clone()),
        ("inPrivateKey".into(), input.in_private_key.clone()),
        ("inBlinding".into(), input.in_blinding.clone()),
        (
            "inPathIndices".into(),
            input
                .in_path_indices
                .iter()
                .map(|&i| BigUint::from(i))
                .collect(),
        ),
        (
            "inPathElements".into(),
            input.in_path_elements.iter().flatten().map(be).collect(),
        ),
        (
            "outputCommitment".into(),
            input.output_commitment.iter().map(be).collect(),
        ),
        ("outAmount".into(), input.out_amount.clone()),
        ("outPubkey".into(), input.out_pubkey.clone()),
        ("outBlinding".into(), input.out_blinding.clone()),
    ])
}

fn mint_to_biguint(mint: &str) -> Result<BigUint> {
    let field = get_mint_address_field(mint);
    if field.chars().all(|c| c.is_ascii_digit()) {
        return BigUint::parse_bytes(field.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid decimal integer"));
    }
    let bytes = bs58::decode(&field)
        .into_vec()
        .map_err(|e| anyhow!("invalid base58 string: {e}"))?;
    Ok(BigUint::from_bytes_be(&bytes))
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
        let hex = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .unwrap_or(s);
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
    let arr = v
        .as_array()
        .ok_or_else(|| anyhow!("expected length-2 array"))?;
    if arr.len() != 2 {
        return Err(anyhow!("expected 2 elements, got {}", arr.len()));
    }
    Ok([parse_bytes32(&arr[0])?, parse_bytes32(&arr[1])?])
}

fn parse_path_index(v: &serde_json::Value) -> Result<usize> {
    if let Some(n) = v.as_u64() {
        return Ok(n as usize);
    }
    if let Some(s) = v.as_str() {
        return s
            .trim()
            .parse::<usize>()
            .map_err(|_| anyhow!("bad path index `{s}`"));
    }
    Err(anyhow!("bad path index {v}"))
}

/// Parses the SDK circuit-input object (`jsonSafeCircuitInput` shape).
pub fn proof_input_from_json(v: &serde_json::Value) -> Result<ProofInput> {
    let in_path_indices = {
        let arr = json_get(v, "inPathIndices")?
            .as_array()
            .ok_or_else(|| anyhow!("inPathIndices must be an array"))?;
        if arr.len() != 2 {
            return Err(anyhow!("inPathIndices must have 2 entries"));
        }
        [parse_path_index(&arr[0])?, parse_path_index(&arr[1])?]
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
            out.push(
                nodes
                    .iter()
                    .map(parse_bytes32)
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        out
    };

    let mint_address = match json_get(v, "mintAddress")? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => return Err(anyhow!("mintAddress must be a string, got {other}")),
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
        mint_address,
        in_path_indices,
        in_path_elements,
        out_amount: parse_vec_biguint(json_get(v, "outAmount")?)?,
        out_blinding: parse_vec_biguint(json_get(v, "outBlinding")?)?,
        out_pubkey: parse_vec_biguint(json_get(v, "outPubkey")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sol_mint_field_matches_sdk() {
        assert_eq!(
            get_mint_address_field(SOL_MINT_PLACEHOLDER),
            SOL_MINT_PLACEHOLDER
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

    /// Raw hash bytes in, little-endian field element out. Matches
    /// `ext_data_hash_matches`, which compares `swab32(sha256)` to the proof.
    #[test]
    fn ext_data_hash_signal_is_little_endian_digest() {
        let mut raw = [0u8; 32];
        raw[0] = 7;
        raw[15] = 9;
        raw[31] = 3;
        let input = ProofInput {
            root: [0u8; 32],
            input_nullifier: [[0u8; 32]; 2],
            output_commitment: [[0u8; 32]; 2],
            public_amount: BigUint::from(0u8),
            ext_data_hash: raw,
            in_amount: vec![],
            in_private_key: vec![],
            in_blinding: vec![],
            mint_address: SOL_MINT_PLACEHOLDER.to_string(),
            in_path_indices: [0, 0],
            in_path_elements: vec![],
            out_amount: vec![],
            out_blinding: vec![],
            out_pubkey: vec![],
        };
        let signal = circuit_inputs(&input)
            .unwrap()
            .into_iter()
            .find(|(name, _)| name == "extDataHash")
            .unwrap()
            .1
            .remove(0);
        assert_eq!(signal, BigUint::from_bytes_le(&raw));
        assert_ne!(signal, BigUint::from_bytes_be(&raw));
    }
}
