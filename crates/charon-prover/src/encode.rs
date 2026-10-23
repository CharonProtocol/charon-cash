//! Proof and public-input encodings expected by the on-chain verifier and SDK.

use anyhow::{anyhow, Result};
use ark_bn254::{Bn254, Fr, G1Affine, G2Affine};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::Proof;
use ark_serialize::CanonicalSerialize;
use num_bigint::BigUint;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone)]
pub struct ProofBytes {
    pub proof_a: Vec<u8>,
    pub proof_b: Vec<u8>,
    pub proof_c: Vec<u8>,
}

/// Hex A/B/C (32/64/32 bytes) and decimal public signals, snarkjs order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedProveResponse {
    pub proof_a: String,
    pub proof_b: String,
    pub proof_c: String,
    pub public_signals: Vec<String>,
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

pub fn to_response(proof: &Proof<Bn254>, public_inputs: &[Fr]) -> Result<CompressedProveResponse> {
    let bytes = proof_to_bytes(proof);
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
        public_signals: public_inputs_to_decimal(public_inputs),
    })
}

fn fr_to_be_bytes_32(x: &Fr) -> [u8; 32] {
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

/// G2 compressed BE is ark LE compressed with a full 64-byte reverse
/// (`solana_bn254::convert_endianness::<64, 64>`), not a per-limb swap.
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

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ec::AffineRepr;

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
}
