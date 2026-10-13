//! Groth16 prover for the Privacy Cash `transaction2` circuit.
//!
//! Inputs are two byte blobs: the snarkjs `transaction2.zkey` and the
//! circom-witnesscalc `transaction2.graph`. There is no Wasmer and no file
//! system access in the proving path, so the same code runs natively and in a
//! browser Web Worker (`--features wasm`, `wasm32-unknown-unknown`).

pub mod encode;
mod groth16;
pub mod input;
pub mod msm;
pub mod reduction;
pub mod witness;
pub mod zkey;

#[cfg(feature = "wasm")]
mod wasm;

use anyhow::{anyhow, ensure, Result};
use ark_bn254::{Bn254, Fr};
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, ProvingKey};
use ark_relations::utils::matrix::Matrix;
use ark_std::UniformRand;
use rand::{CryptoRng, RngCore};

pub use encode::{
    proof_to_bytes, public_inputs_to_bytes, public_inputs_to_decimal, CompressedProveResponse,
    ProofBytes,
};
pub use input::{
    circuit_inputs, get_mint_address_field, proof_input_from_json, ProofInput, FIELD_SIZE_DECIMAL,
};
pub use groth16::set_ark_msm;
pub use witness::WitnessGraph;

#[derive(Debug, Clone)]
pub struct ProofArtifacts {
    pub proof: Proof<Bn254>,
    /// The 7 public signals, snarkjs order (witness[1..8]).
    pub public_inputs: Vec<Fr>,
}

/// Parsed proving key, constraint matrices and witness graph. Build once per
/// process (or Worker) and reuse for every proof.
pub struct Prover {
    pk: ProvingKey<Bn254>,
    pvk: PreparedVerifyingKey<Bn254>,
    ab: Vec<Matrix<Fr>>,
    num_instance_variables: usize,
    num_constraints: usize,
    graph: WitnessGraph,
}

impl Prover {
    pub fn new(zkey_bytes: &[u8], graph_bytes: &[u8]) -> Result<Self> {
        let (pk, m) = zkey::read_zkey(zkey_bytes)?;
        let graph = WitnessGraph::from_bytes(graph_bytes)?;
        ensure!(
            graph.witness_len() == pk.a_query.len(),
            "graph produces {} witness values but the zkey expects {}; \
             the graph and zkey were built from different circuits",
            graph.witness_len(),
            pk.a_query.len()
        );
        ensure!(m.num_instance_variables > 1, "zkey has no public inputs");
        let pvk = ark_groth16::prepare_verifying_key(&pk.vk);
        Ok(Self {
            pk,
            pvk,
            ab: vec![m.a, m.b],
            num_instance_variables: m.num_instance_variables,
            num_constraints: m.num_constraints,
            graph,
        })
    }

    /// Loads `<base>.zkey` and `<base>.graph`.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn from_circuit_base(base: &std::path::Path) -> Result<Self> {
        let read = |ext: &str| {
            let p = base.with_extension(ext);
            std::fs::read(&p).map_err(|e| anyhow!("cannot read {}: {e}", p.display()))
        };
        Self::new(&read("zkey")?, &read("graph")?)
    }

    pub fn witness(&self, input: &ProofInput) -> Result<Vec<Fr>> {
        self.graph.calculate_witness(&circuit_inputs(input)?)
    }

    pub fn prove(&self, input: &ProofInput) -> Result<ProofArtifacts> {
        self.prove_with_rng(input, &mut rand::rngs::OsRng)
    }

    pub fn prove_with_rng<R: RngCore + CryptoRng>(
        &self,
        input: &ProofInput,
        rng: &mut R,
    ) -> Result<ProofArtifacts> {
        let witness = self.witness(input)?;
        self.prove_witness(&witness, rng)
    }

    /// Like [`Prover::prove`] but skips the self-check, so an unsatisfied
    /// witness yields a proof the verifier will reject. For negative tests
    /// that need the on-chain verifier to do the rejecting.
    pub fn prove_unverified(&self, input: &ProofInput) -> Result<ProofArtifacts> {
        let witness = self.witness(input)?;
        self.create_proof(&witness, &mut rand::rngs::OsRng)
    }

    /// Proves an already computed full assignment (`witness[0] == 1`).
    pub fn prove_witness<R: RngCore + CryptoRng>(
        &self,
        witness: &[Fr],
        rng: &mut R,
    ) -> Result<ProofArtifacts> {
        let artifacts = self.create_proof(witness, rng)?;
        // An unsatisfied witness still yields a proof; catch it before it
        // reaches the chain.
        let ok =
            Groth16::<Bn254>::verify_proof(&self.pvk, &artifacts.proof, &artifacts.public_inputs)
                .unwrap_or(false);
        if !ok {
            return Err(anyhow!(
                "proof does not verify: the circuit inputs do not satisfy transaction2 \
                 (wrong root, path, nullifier, commitment or amounts)"
            ));
        }
        Ok(artifacts)
    }

    fn create_proof<R: RngCore + CryptoRng>(
        &self,
        witness: &[Fr],
        rng: &mut R,
    ) -> Result<ProofArtifacts> {
        ensure!(
            witness.len() == self.pk.a_query.len(),
            "witness has {} values, expected {}",
            witness.len(),
            self.pk.a_query.len()
        );
        let r = Fr::rand(rng);
        let s = Fr::rand(rng);
        let proof = groth16::create_proof(
            &self.pk,
            r,
            s,
            &self.ab,
            self.num_instance_variables,
            self.num_constraints,
            witness,
        )?;
        let public_inputs = witness[1..self.num_instance_variables].to_vec();
        Ok(ProofArtifacts {
            proof,
            public_inputs,
        })
    }

    /// SDK entry point: circuit-input object -> hex A/B/C + decimal publics.
    pub fn prove_value(&self, value: &serde_json::Value) -> Result<CompressedProveResponse> {
        let input = proof_input_from_json(value)?;
        let artifacts = self.prove(&input)?;
        encode::to_response(&artifacts.proof, &artifacts.public_inputs)
    }

    pub fn prove_json(&self, json: &str) -> Result<CompressedProveResponse> {
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|e| anyhow!("invalid circuit input json: {e}"))?;
        self.prove_value(&value)
    }
}

/// `programs/privacy-cash/artifacts/circuits/transaction2` in this repo, or
/// `$CIRCUIT_BASE` when set.
#[cfg(not(target_arch = "wasm32"))]
pub fn default_circuit_base() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("CIRCUIT_BASE") {
        return p.into();
    }
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../programs/privacy-cash/artifacts/circuits/transaction2")
}
