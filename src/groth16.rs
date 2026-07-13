use solana_bn254::prelude::{
    alt_bn128_g1_addition_be, alt_bn128_g1_multiplication_be, alt_bn128_pairing_be,
};

/// BN254 scalar field modulus r (Fr), big-endian.
/// 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
pub const FR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
    0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00,
    0x00, 0x01,
];

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
        let mut mul_input = [0u8; 96];
        let mut add_input = [0u8; 128];

        for (i, input) in self.public_inputs.iter().enumerate() {
            if CHECK && !is_less_than_bn254_field_size_be(input) {
                return Err(Groth16Error::PublicInputGreaterThanFieldSize);
            }
            mul_input[..64].copy_from_slice(&self.verifyingkey.vk_ic[i + 1]);
            mul_input[64..].copy_from_slice(input);
            let mul_res = alt_bn128_g1_multiplication_be(&mul_input)
                .map_err(|_| Groth16Error::PreparingInputsG1MulFailed)?;
            add_input[..64].copy_from_slice(&mul_res);
            add_input[64..].copy_from_slice(&prepared_public_inputs);
            prepared_public_inputs = alt_bn128_g1_addition_be(&add_input)
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

        let mut pairing_input = [0u8; 768];
        pairing_input[0..64].copy_from_slice(self.proof_a);
        pairing_input[64..192].copy_from_slice(self.proof_b);
        pairing_input[192..256].copy_from_slice(&self.prepared_public_inputs);
        pairing_input[256..384].copy_from_slice(&self.verifyingkey.vk_gamme_g2);
        pairing_input[384..448].copy_from_slice(self.proof_c);
        pairing_input[448..576].copy_from_slice(&self.verifyingkey.vk_delta_g2);
        pairing_input[576..640].copy_from_slice(&self.verifyingkey.vk_alpha_g1);
        pairing_input[640..768].copy_from_slice(&self.verifyingkey.vk_beta_g2);

        let pairing_res = alt_bn128_pairing_be(&pairing_input)
            .map_err(|_| Groth16Error::ProofVerificationFailed)?;

        if pairing_res[31] != 1 {
            return Err(Groth16Error::ProofVerificationFailed);
        }
        Ok(true)
    }
}

/// Strict `bytes < r` on big-endian 32-byte values. Lexicographic comparison
/// of equal-length big-endian arrays equals numeric comparison.
///
/// This check is load-bearing for soundness: the alt_bn128 multiplication
/// syscall does not range-check scalars, so without it `input + r` would be
/// accepted as an alias of `input` (e.g. a nullifier replay).
pub fn is_less_than_bn254_field_size_be(bytes: &[u8; 32]) -> bool {
    bytes < &FR_MODULUS_BE
}
