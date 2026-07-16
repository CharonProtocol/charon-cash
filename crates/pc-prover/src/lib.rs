//! Groth16 proving for privacy-cash.
//!
//! Wraps `circom-prover` (native witness via `rust-witness`, arkworks prover) against the
//! **unmodified** upstream `transaction2.zkey`, and serializes the result into the exact byte
//! layout the on-chain program expects.
//!
//! Two things are load-bearing and non-obvious:
//!
//! * **`proofA` is emitted un-negated.** The program negates it during the pairing check, so the
//!   client must not. `proofB` uses the arkworks/solana G2 convention of `c1` before `c0` per
//!   Fp2 coordinate.
//! * **A groth16 proof is randomized** (snarkjs/arkworks draw `r,s` per call), so two proofs of
//!   the same statement differ byte-for-byte. The *public signals* are deterministic; the proof
//!   points are not. Correctness is therefore "it verifies", not "it matches a golden blob".

use anyhow::{anyhow, Result};
use circom_prover::{
    prover::{circom::Proof as CircomProofPoints, CircomProof, ProofLib},
    witness::WitnessFn,
    CircomProver,
};
use num_bigint::BigUint;
use pc_core::field::fr_to_decimal;
use pc_core::Fr;
use std::collections::HashMap;

pub const MERKLE_DEPTH: usize = 26;
/// Number of public signals: root, publicAmount, extDataHash, 2 nullifiers, 2 commitments.
pub const NUM_PUBLIC_SIGNALS: usize = 7;

// Binds the native witness calculator transpiled from transaction2.wasm by build.rs.
rust_witness::witness!(transaction2);

/// The 2-in/2-out circuit's inputs, as field elements. Field names mirror the circom signal
/// names so the mapping to the witness calculator is direct.
#[derive(Clone)]
pub struct CircuitInputs {
    pub root: Fr,
    pub public_amount: Fr,
    pub ext_data_hash: Fr,
    /// The circuit's (truncated) mint field — see [`pc_core::mint`].
    pub mint_address: Fr,
    pub input_nullifiers: [Fr; 2],
    pub in_amounts: [Fr; 2],
    pub in_private_keys: [Fr; 2],
    pub in_blindings: [Fr; 2],
    pub in_path_indices: [Fr; 2],
    pub in_path_elements: [[Fr; MERKLE_DEPTH]; 2],
    pub output_commitments: [Fr; 2],
    pub out_amounts: [Fr; 2],
    pub out_pubkeys: [Fr; 2],
    pub out_blindings: [Fr; 2],
}

impl CircuitInputs {
    /// The witness-calculator input map: signal name → decimal-string values, with nested arrays
    /// flattened row-major (input 0's 26 path elements, then input 1's), exactly as snarkjs feeds
    /// the wasm.
    fn to_input_map(&self) -> HashMap<String, Vec<String>> {
        let d = |x: &Fr| fr_to_decimal(x);
        let pair = |a: &[Fr; 2]| vec![d(&a[0]), d(&a[1])];

        let mut path = Vec::with_capacity(2 * MERKLE_DEPTH);
        for row in &self.in_path_elements {
            for el in row {
                path.push(d(el));
            }
        }

        HashMap::from([
            ("root".into(), vec![d(&self.root)]),
            ("publicAmount".into(), vec![d(&self.public_amount)]),
            ("extDataHash".into(), vec![d(&self.ext_data_hash)]),
            ("mintAddress".into(), vec![d(&self.mint_address)]),
            ("inputNullifier".into(), pair(&self.input_nullifiers)),
            ("inAmount".into(), pair(&self.in_amounts)),
            ("inPrivateKey".into(), pair(&self.in_private_keys)),
            ("inBlinding".into(), pair(&self.in_blindings)),
            ("inPathIndices".into(), pair(&self.in_path_indices)),
            ("inPathElements".into(), path),
            ("outputCommitment".into(), pair(&self.output_commitments)),
            ("outAmount".into(), pair(&self.out_amounts)),
            ("outPubkey".into(), pair(&self.out_pubkeys)),
            ("outBlinding".into(), pair(&self.out_blindings)),
        ])
    }
}

/// A proof serialized in the program's on-chain byte format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofBytes {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    /// root, publicAmount, extDataHash, nullifier[0..2], commitment[0..2], each big-endian.
    pub public_signals: [[u8; 32]; NUM_PUBLIC_SIGNALS],
}

/// Generate a proof for `inputs` against the zkey at `zkey_path`.
pub fn prove(inputs: &CircuitInputs, zkey_path: &str) -> Result<ProofBytes> {
    let input_json = serde_json::to_string(&inputs.to_input_map())?;
    let CircomProof { proof, pub_inputs } = CircomProver::prove(
        ProofLib::Arkworks,
        WitnessFn::RustWitness(transaction2_witness),
        input_json,
        zkey_path.to_string(),
    )?;
    serialize(proof, pub_inputs.0)
}

/// Verify a proof against the zkey — a self-check that does *not* exercise the on-chain byte
/// format (the program's verifier is the authority on that). Used to sanity-gate proving.
pub fn verify(proof: CircomProof, zkey_path: &str) -> Result<bool> {
    Ok(CircomProver::verify(ProofLib::Arkworks, proof, zkey_path.to_string())?)
}

/// Big-endian 32-byte encoding of a field element (`< 2^254`, so always ≤ 32 bytes).
fn be32(n: &BigUint) -> [u8; 32] {
    let bytes = n.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - bytes.len()..].copy_from_slice(&bytes);
    out
}

fn serialize(proof: CircomProofPoints, pub_inputs: Vec<BigUint>) -> Result<ProofBytes> {
    if pub_inputs.len() != NUM_PUBLIC_SIGNALS {
        return Err(anyhow!(
            "expected {} public signals, got {}",
            NUM_PUBLIC_SIGNALS,
            pub_inputs.len()
        ));
    }

    // A/C: be(x) || be(y), affine, un-negated.
    let mut proof_a = [0u8; 64];
    proof_a[..32].copy_from_slice(&be32(&proof.a.x));
    proof_a[32..].copy_from_slice(&be32(&proof.a.y));

    let mut proof_c = [0u8; 64];
    proof_c[..32].copy_from_slice(&be32(&proof.c.x));
    proof_c[32..].copy_from_slice(&be32(&proof.c.y));

    // B: c1-before-c0 per Fp2 coordinate. circom stores x = [c0, c1], so take [1] then [0].
    let mut proof_b = [0u8; 128];
    proof_b[..32].copy_from_slice(&be32(&proof.b.x[1]));
    proof_b[32..64].copy_from_slice(&be32(&proof.b.x[0]));
    proof_b[64..96].copy_from_slice(&be32(&proof.b.y[1]));
    proof_b[96..].copy_from_slice(&be32(&proof.b.y[0]));

    let mut public_signals = [[0u8; 32]; NUM_PUBLIC_SIGNALS];
    for (slot, sig) in public_signals.iter_mut().zip(pub_inputs.iter()) {
        *slot = be32(sig);
    }

    Ok(ProofBytes {
        proof_a,
        proof_b,
        proof_c,
        public_signals,
    })
}
