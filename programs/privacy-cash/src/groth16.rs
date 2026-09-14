// Source is taken from: https://github.com/Lightprotocol/groth16-solana/blob/master/src/groth16.rs
// Ported 1:1 from the Anchor program (`privacy-cash-orignal/.../groth16.rs`).
// We don't need checked math on public inputs, because the passed in public
// input length is fixed at 7.
use crate::field::{lt_be, FR_BE};
use solana_bn254::prelude::{
    alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be,
};

#[derive(Debug, PartialEq, Eq)]
pub enum Groth16Error {
    InvalidG1Length,
    InvalidG2Length,
    InvalidPublicInputsLength,
    PublicInputGreaterThanFieldSize,
    PreparingInputsG1MulFailed,
    PreparingInputsG1AdditionFailed,
    ProofVerificationFailed,
}

#[derive(PartialEq, Eq, Debug)]
pub struct Groth16Verifyingkey<'a> {
    pub nr_pubinputs: usize,
    pub vk_alpha_g1: [u8; 64],
    pub vk_beta_g2: [u8; 128],
    pub vk_gamme_g2: [u8; 128],
    pub vk_delta_g2: [u8; 128],
    pub vk_ic: &'a [[u8; 64]],
}

#[derive(PartialEq, Eq, Debug)]
pub struct Groth16Verifier<'a, const NR_INPUTS: usize> {
    proof_a: &'a [u8; 64],
    proof_b: &'a [u8; 128],
    proof_c: &'a [u8; 64],
    public_inputs: &'a [[u8; 32]; NR_INPUTS],
    prepared_public_inputs: [u8; 64],
    verifyingkey: &'a Groth16Verifyingkey<'a>,
}

impl<const NR_INPUTS: usize> Groth16Verifier<'_, NR_INPUTS> {
    pub fn new<'a>(
        proof_a: &'a [u8; 64],
        proof_b: &'a [u8; 128],
        proof_c: &'a [u8; 64],
        public_inputs: &'a [[u8; 32]; NR_INPUTS],
        verifyingkey: &'a Groth16Verifyingkey<'a>,
    ) -> Result<Groth16Verifier<'a, NR_INPUTS>, Groth16Error> {
        if proof_a.len() != 64 {
            return Err(Groth16Error::InvalidG1Length);
        }

        if proof_b.len() != 128 {
            return Err(Groth16Error::InvalidG2Length);
        }

        if proof_c.len() != 64 {
            return Err(Groth16Error::InvalidG1Length);
        }

        if public_inputs.len() + 1 != verifyingkey.vk_ic.len() {
            return Err(Groth16Error::InvalidPublicInputsLength);
        }

        Ok(Groth16Verifier {
            proof_a,
            proof_b,
            proof_c,
            public_inputs,
            prepared_public_inputs: [0u8; 64],
            verifyingkey,
        })
    }

    pub fn prepare_inputs<const CHECK: bool>(&mut self) -> Result<(), Groth16Error> {
        let mut prepared_public_inputs = self.verifyingkey.vk_ic[0];

        // Both syscall arguments have a fixed size, so they are assembled once
        // on the stack and overwritten each round rather than reallocated.
        let mut mul_input = [0u8; 96];
        let mut addition_input = [0u8; 128];

        for (i, input) in self.public_inputs.iter().enumerate() {
            if CHECK && !is_less_than_bn254_field_size_be(input) {
                return Err(Groth16Error::PublicInputGreaterThanFieldSize);
            }

            mul_input[..64].copy_from_slice(&self.verifyingkey.vk_ic[i + 1]);
            mul_input[64..].copy_from_slice(input);

            let mul_res = alt_bn128_g1_multiplication_be(&mul_input)
                .map_err(|_| Groth16Error::PreparingInputsG1MulFailed)?;

            addition_input[..64].copy_from_slice(&mul_res);
            addition_input[64..].copy_from_slice(&prepared_public_inputs);

            prepared_public_inputs = alt_bn128_g1_addition_be(&addition_input)
                .map_err(|_| Groth16Error::PreparingInputsG1AdditionFailed)?[..]
                .try_into()
                .map_err(|_| Groth16Error::PreparingInputsG1AdditionFailed)?;
        }

        self.prepared_public_inputs = prepared_public_inputs;

        Ok(())
    }

    /// Verifies the proof, and checks that public inputs are smaller than
    /// field size.
    pub fn verify(&mut self) -> Result<bool, Groth16Error> {
        self.verify_common::<true>()
    }

    /// Verifies the proof, and does not check that public inputs are smaller
    /// than field size.
    pub fn verify_unchecked(&mut self) -> Result<bool, Groth16Error> {
        self.verify_common::<false>()
    }

    fn verify_common<const CHECK: bool>(&mut self) -> Result<bool, Groth16Error> {
        self.prepare_inputs::<CHECK>()?;

        // Four (G1, G2) pairs: 4 * (64 + 128) bytes, known at compile time.
        let mut pairing_input = [0u8; 4 * (64 + 128)];
        let mut offset = 0;
        for part in [
            self.proof_a.as_slice(),
            self.proof_b.as_slice(),
            self.prepared_public_inputs.as_slice(),
            self.verifyingkey.vk_gamme_g2.as_slice(),
            self.proof_c.as_slice(),
            self.verifyingkey.vk_delta_g2.as_slice(),
            self.verifyingkey.vk_alpha_g1.as_slice(),
            self.verifyingkey.vk_beta_g2.as_slice(),
        ] {
            pairing_input[offset..offset + part.len()].copy_from_slice(part);
            offset += part.len();
        }

        let pairing_res = alt_bn128_pairing_be(&pairing_input)
            .map_err(|_| Groth16Error::ProofVerificationFailed)?;

        if pairing_res[31] != 1 {
            return Err(Groth16Error::ProofVerificationFailed);
        }
        Ok(true)
    }
}

/// Whether a public input is a canonical scalar field element.
///
/// A lexicographic comparison of big-endian bytes against `r` is the same
/// ordering as the integer comparison, without building two `BigUint`s per
/// call to get there.
pub fn is_less_than_bn254_field_size_be(bytes: &[u8; 32]) -> bool {
    lt_be(bytes, &FR_BE)
}
