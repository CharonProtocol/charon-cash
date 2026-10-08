//! Input decoding with size caps.
//!
//! Every helper here rejects rather than truncates. These run before any RPC work,
//! so a malformed or oversized request costs nothing but a parse.

use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

use crate::relayer::build::ProofBytes;
use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};

/// Ciphertexts are ~200 bytes in practice. The cap exists so a caller cannot make
/// us hash and simulate megabytes before we discover the transaction is too large.
pub const MAX_ENCRYPTED_OUTPUT_BYTES: usize = 2_048;
/// Jupiter route data for a v1 swap.
pub const MAX_ROUTE_DATA_BYTES: usize = 2_048;

pub fn decode_hex(field: &str, value: &str) -> RelayerResult<Vec<u8>> {
    let trimmed = value.trim().trim_start_matches("0x");
    hex::decode(trimmed).map_err(|e| {
        RelayerError::new(
            ErrorCode::InvalidEncoding,
            format!("{field} is not valid hex: {e}"),
        )
    })
}

pub fn decode_fixed<const N: usize>(field: &str, value: &str) -> RelayerResult<[u8; N]> {
    let bytes = decode_hex(field, value)?;
    if bytes.len() != N {
        return Err(RelayerError::invalid(format!(
            "{field} must be {N} bytes, got {}",
            bytes.len()
        )));
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn decode_bounded_hex(field: &str, value: &str, max: usize) -> RelayerResult<Vec<u8>> {
    let bytes = decode_hex(field, value)?;
    if bytes.len() > max {
        return Err(RelayerError::invalid(format!(
            "{field} is {} bytes, over the {max}-byte cap",
            bytes.len()
        )));
    }
    Ok(bytes)
}

pub fn parse_pubkey(field: &str, value: &str) -> RelayerResult<Pubkey> {
    Pubkey::from_str(value.trim()).map_err(|e| {
        RelayerError::new(
            ErrorCode::InvalidEncoding,
            format!("{field} is not a base58 pubkey: {e}"),
        )
    })
}

/// Amounts arrive as strings because `ext_amount` is a signed 64-bit value and
/// JSON numbers cannot carry the full range safely.
pub fn parse_i64(field: &str, value: &str) -> RelayerResult<i64> {
    value
        .trim()
        .parse()
        .map_err(|e| RelayerError::invalid(format!("{field} is not a valid i64: {e}")))
}

pub fn parse_u64(field: &str, value: &str) -> RelayerResult<u64> {
    value
        .trim()
        .parse()
        .map_err(|e| RelayerError::invalid(format!("{field} is not a valid u64: {e}")))
}

/// Wire form of a Groth16 proof plus its public inputs, all hex.
#[derive(serde::Deserialize)]
pub struct ProofPayload {
    pub proof_a: String,
    pub proof_b: String,
    pub proof_c: String,
    pub root: String,
    pub public_amount: String,
    pub ext_data_hash: String,
    pub input_nullifiers: Vec<String>,
    pub output_commitments: Vec<String>,
}

impl ProofPayload {
    pub fn decode(&self) -> RelayerResult<ProofBytes> {
        if self.input_nullifiers.len() != 2 {
            return Err(RelayerError::invalid(format!(
                "expected 2 input nullifiers, got {}",
                self.input_nullifiers.len()
            )));
        }
        if self.output_commitments.len() != 2 {
            return Err(RelayerError::invalid(format!(
                "expected 2 output commitments, got {}",
                self.output_commitments.len()
            )));
        }
        Ok(ProofBytes {
            proof_a: decode_fixed("proof_a", &self.proof_a)?,
            proof_b: decode_fixed("proof_b", &self.proof_b)?,
            proof_c: decode_fixed("proof_c", &self.proof_c)?,
            root: decode_fixed("root", &self.root)?,
            public_amount: decode_fixed("public_amount", &self.public_amount)?,
            ext_data_hash: decode_fixed("ext_data_hash", &self.ext_data_hash)?,
            input_nullifiers: [
                decode_fixed("input_nullifiers[0]", &self.input_nullifiers[0])?,
                decode_fixed("input_nullifiers[1]", &self.input_nullifiers[1])?,
            ],
            output_commitments: [
                decode_fixed("output_commitments[0]", &self.output_commitments[0])?,
                decode_fixed("output_commitments[1]", &self.output_commitments[1])?,
            ],
        })
    }
}

/// The mint field that goes into `ext_data_hash`. The protocol uses the base58
/// string `1111…2` for native SOL rather than the wrapped-SOL mint, so this has to
/// accept both spellings and hash whatever the client committed to.
pub fn mint_hash_bytes(mint: &str) -> RelayerResult<[u8; 32]> {
    let pk = parse_pubkey("mint", mint)?;
    Ok(pk.to_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_width_decoding_rejects_wrong_length() {
        assert!(decode_fixed::<32>("root", &"aa".repeat(32)).is_ok());
        assert!(decode_fixed::<32>("root", &"aa".repeat(31)).is_err());
        assert!(decode_fixed::<32>("root", &format!("0x{}", "aa".repeat(32))).is_ok());
    }

    #[test]
    fn bounded_hex_enforces_cap() {
        assert!(decode_bounded_hex("enc", &"ff".repeat(10), 10).is_ok());
        assert!(decode_bounded_hex("enc", &"ff".repeat(11), 10).is_err());
    }

    #[test]
    fn negative_ext_amount_parses() {
        assert_eq!(parse_i64("ext_amount", "-1000000").unwrap(), -1_000_000);
        assert!(parse_u64("fee", "-1").is_err());
    }
}
