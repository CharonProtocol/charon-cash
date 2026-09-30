//! Test-side proving through `privacy_cash_prover`, the same Rust prover the
//! browser runs as wasm: witness from `transaction2.graph`, proof from
//! `transaction2.zkey`.

use anyhow::{anyhow, Result};
use privacy_cash_prover::Prover;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub use privacy_cash_prover::{ProofArtifacts as DepositProofArtifacts, ProofBytes, ProofInput};

use crate::common::utils::get_mint_address_field;

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

static PROVER: Mutex<Option<(PathBuf, Arc<Prover>)>> = Mutex::new(None);

fn prover_for(key_base_path: &Path) -> Result<Arc<Prover>> {
    let mut slot = PROVER
        .lock()
        .map_err(|_| anyhow!("prover cache poisoned"))?;
    if let Some((path, prover)) = slot.as_ref() {
        if path == key_base_path {
            return Ok(prover.clone());
        }
    }
    let prover = Arc::new(Prover::from_circuit_base(key_base_path)?);
    *slot = Some((key_base_path.to_path_buf(), prover.clone()));
    Ok(prover)
}

/// Proves with `<key_base_path>.graph` + `<key_base_path>.zkey`. The prover
/// verifies the proof before returning it.
pub fn prove(input: &ProofInput, key_base_path: &Path) -> Result<DepositProofArtifacts> {
    prover_for(key_base_path)?.prove(&circuit_input(input))
}

/// For attack tests: returns a proof even when the inputs do not satisfy the
/// circuit, so the program's verifier is what rejects the transaction.
pub fn prove_unverified(input: &ProofInput, key_base_path: &Path) -> Result<DepositProofArtifacts> {
    prover_for(key_base_path)?.prove_unverified(&circuit_input(input))
}

fn circuit_input(input: &ProofInput) -> ProofInput {
    let mut input = input.clone();
    // Tests carry base58 mints; the circuit takes the 31-byte field element.
    input.mint_address = get_mint_address_field(&input.mint_address);
    input
}

/// Convert the proof + public inputs into the exact submit shape used by the SDK.
pub fn deposit_artifacts_to_submit(
    artifacts: &DepositProofArtifacts,
    compressed: bool,
) -> Result<DepositProofToSubmit> {
    let proof_bytes = proof_to_bytes(&artifacts.proof, true);
    let public_inputs_bytes = privacy_cash_prover::public_inputs_to_bytes(&artifacts.public_inputs);

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

/// Always emit ark-compressed BE points (32/64/32). `compressed` is ignored.
pub fn proof_to_bytes(
    proof: &ark_groth16::Proof<ark_bn254::Bn254>,
    _compressed: bool,
) -> ProofBytes {
    privacy_cash_prover::proof_to_bytes(proof)
}
