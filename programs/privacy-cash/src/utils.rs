use crate::error::PrivacyCashError;
use crate::groth16::{Groth16Verifier, Groth16Verifyingkey};
use crate::state::{Proof, ProofBatch3};
use ark_bn254::Fr;
use ark_ff::PrimeField;
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use core::ops::Neg;
use light_hasher::{Hasher, Sha256};
use pinocchio::error::ProgramError;

type G1 = ark_bn254::g1::G1Affine;

pub const VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 7,

    vk_alpha_g1: [
        45, 77, 154, 167, 227, 2, 217, 223, 65, 116, 157, 85, 7, 148, 157, 5, 219, 234, 51, 251,
        177, 108, 100, 59, 34, 245, 153, 162, 190, 109, 242, 226, 20, 190, 221, 80, 60, 55, 206,
        176, 97, 216, 236, 96, 32, 159, 227, 69, 206, 137, 131, 10, 25, 35, 3, 1, 240, 118, 202,
        255, 0, 77, 25, 38,
    ],

    vk_beta_g2: [
        9, 103, 3, 47, 203, 247, 118, 209, 175, 201, 133, 248, 136, 119, 241, 130, 211, 132, 128,
        166, 83, 242, 222, 202, 169, 121, 76, 188, 59, 243, 6, 12, 14, 24, 120, 71, 173, 76, 121,
        131, 116, 208, 214, 115, 43, 245, 1, 132, 125, 214, 139, 192, 224, 113, 36, 30, 2, 19, 188,
        127, 193, 61, 183, 171, 48, 76, 251, 209, 224, 138, 112, 74, 153, 245, 232, 71, 217, 63,
        140, 60, 170, 253, 222, 196, 107, 122, 13, 55, 157, 166, 154, 77, 17, 35, 70, 167, 23, 57,
        193, 177, 164, 87, 168, 199, 49, 49, 35, 210, 77, 47, 145, 146, 248, 150, 183, 198, 62,
        234, 5, 169, 213, 127, 6, 84, 122, 208, 206, 200,
    ],

    vk_gamme_g2: [
        25, 142, 147, 147, 146, 13, 72, 58, 114, 96, 191, 183, 49, 251, 93, 37, 241, 170, 73, 51,
        53, 169, 231, 18, 151, 228, 133, 183, 174, 243, 18, 194, 24, 0, 222, 239, 18, 31, 30, 118,
        66, 106, 0, 102, 94, 92, 68, 121, 103, 67, 34, 212, 247, 94, 218, 221, 70, 222, 189, 92,
        217, 146, 246, 237, 9, 6, 137, 208, 88, 95, 240, 117, 236, 158, 153, 173, 105, 12, 51, 149,
        188, 75, 49, 51, 112, 179, 142, 243, 85, 172, 218, 220, 209, 34, 151, 91, 18, 200, 94, 165,
        219, 140, 109, 235, 74, 171, 113, 128, 141, 203, 64, 143, 227, 209, 231, 105, 12, 67, 211,
        123, 76, 230, 204, 1, 102, 250, 125, 170,
    ],

    vk_delta_g2: [
        25, 252, 204, 73, 0, 218, 132, 40, 192, 175, 106, 179, 247, 34, 6, 163, 111, 68, 46, 211,
        76, 146, 16, 158, 28, 23, 146, 254, 157, 94, 7, 92, 34, 128, 9, 143, 49, 11, 128, 172, 203,
        141, 109, 166, 180, 82, 110, 179, 223, 71, 56, 138, 77, 154, 73, 160, 146, 198, 203, 125,
        196, 135, 167, 56, 21, 152, 106, 224, 184, 3, 47, 85, 250, 118, 220, 185, 175, 242, 111,
        30, 40, 24, 69, 173, 252, 13, 109, 1, 241, 162, 122, 76, 24, 38, 72, 88, 45, 118, 91, 197,
        236, 236, 152, 29, 29, 233, 108, 250, 155, 255, 230, 156, 182, 159, 1, 3, 41, 60, 40, 136,
        181, 220, 23, 150, 130, 211, 23, 83,
    ],

    vk_ic: &[
        [
            35, 121, 23, 162, 32, 101, 247, 115, 177, 199, 50, 158, 3, 60, 188, 95, 91, 29, 121,
            210, 53, 155, 245, 226, 203, 245, 186, 167, 39, 32, 160, 202, 22, 22, 168, 160, 125,
            45, 56, 45, 132, 214, 20, 198, 76, 81, 2, 150, 0, 61, 86, 130, 105, 170, 141, 244, 13,
            180, 81, 79, 18, 166, 129, 129,
        ],
        [
            13, 148, 63, 234, 185, 42, 3, 159, 127, 24, 240, 200, 72, 24, 176, 7, 181, 215, 212,
            52, 13, 160, 172, 182, 177, 22, 235, 4, 173, 229, 25, 108, 46, 61, 233, 184, 181, 152,
            132, 103, 252, 100, 229, 144, 217, 36, 39, 254, 67, 237, 70, 214, 192, 231, 140, 86,
            113, 40, 11, 88, 12, 150, 157, 226,
        ],
        [
            26, 105, 150, 204, 178, 202, 26, 62, 39, 178, 179, 225, 133, 140, 138, 40, 60, 187, 99,
            57, 237, 7, 203, 159, 251, 103, 46, 207, 219, 186, 19, 64, 0, 42, 73, 5, 76, 48, 115,
            80, 96, 29, 197, 213, 228, 240, 7, 144, 140, 3, 127, 89, 87, 247, 98, 153, 174, 81, 7,
            158, 183, 80, 139, 147,
        ],
        [
            6, 249, 88, 104, 56, 74, 144, 136, 129, 176, 70, 216, 18, 147, 78, 141, 24, 93, 95,
            242, 68, 49, 215, 152, 246, 110, 151, 241, 228, 59, 230, 187, 29, 56, 186, 210, 200,
            190, 93, 64, 110, 0, 55, 105, 166, 104, 208, 46, 82, 81, 146, 136, 179, 99, 104, 232,
            99, 248, 162, 137, 21, 217, 220, 77,
        ],
        [
            34, 163, 170, 91, 254, 215, 220, 175, 71, 67, 56, 43, 178, 48, 92, 7, 170, 124, 201,
            232, 207, 202, 134, 80, 123, 31, 26, 236, 76, 175, 186, 155, 46, 253, 236, 170, 12,
            248, 30, 127, 51, 136, 100, 51, 34, 7, 218, 21, 133, 51, 148, 235, 92, 210, 117, 134,
            121, 78, 166, 90, 10, 194, 193, 148,
        ],
        [
            36, 180, 82, 206, 231, 195, 86, 41, 106, 145, 21, 107, 234, 233, 139, 225, 54, 131,
            165, 186, 77, 127, 180, 146, 240, 188, 64, 37, 52, 96, 13, 163, 24, 163, 180, 194, 36,
            190, 184, 250, 134, 211, 189, 81, 228, 125, 4, 21, 20, 20, 255, 26, 142, 105, 230, 174,
            244, 121, 184, 65, 9, 40, 77, 148,
        ],
        [
            11, 24, 12, 201, 201, 217, 179, 163, 6, 167, 37, 40, 172, 236, 81, 246, 31, 38, 112,
            17, 100, 163, 111, 57, 31, 198, 231, 63, 224, 178, 38, 76, 12, 154, 160, 41, 58, 177,
            5, 197, 223, 113, 12, 75, 237, 239, 9, 40, 178, 44, 222, 130, 125, 221, 142, 241, 213,
            58, 131, 242, 120, 108, 213, 163,
        ],
        [
            1, 83, 134, 187, 30, 49, 61, 118, 206, 110, 225, 192, 155, 101, 155, 204, 202, 49, 229,
            41, 148, 232, 24, 47, 85, 47, 108, 99, 113, 12, 209, 88, 41, 144, 185, 30, 176, 46,
            190, 244, 148, 151, 142, 64, 45, 22, 16, 17, 48, 122, 183, 81, 187, 18, 142, 10, 230,
            78, 6, 42, 245, 140, 166, 121,
        ],
    ],
};

pub fn validate_fee(
    ext_amount: i64,
    provided_fee: u64,
    deposit_fee_rate: u16,
    withdrawal_fee_rate: u16,
    fee_error_margin: u16,
) -> Result<(), ProgramError> {
    if ext_amount == 0 {
        return Ok(());
    }

    let fee_rate = if ext_amount > 0 {
        deposit_fee_rate
    } else {
        withdrawal_fee_rate
    };

    let amount_abs = if ext_amount > 0 {
        ext_amount as u64
    } else {
        (-ext_amount) as u64
    };

    let expected_fee = amount_abs
        .checked_mul(fee_rate as u64)
        .and_then(|v| v.checked_div(10_000))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let min_acceptable_fee = expected_fee
        .checked_mul((10_000u64).saturating_sub(fee_error_margin as u64))
        .and_then(|v| v.checked_div(10_000))
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if provided_fee < min_acceptable_fee {
        return Err(PrivacyCashError::InvalidFeeAmount.into());
    }

    Ok(())
}

pub fn calculate_complete_ext_data_hash(
    recipient: &[u8; 32],
    ext_amount: i64,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    fee: u64,
    fee_recipient: &[u8; 32],
    mint_address: &[u8; 32],
) -> Result<[u8; 32], ProgramError> {
    let mut data = Vec::new();

    data.extend_from_slice(recipient);
    data.extend_from_slice(&ext_amount.to_le_bytes());
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);
    data.extend_from_slice(&fee.to_le_bytes());
    data.extend_from_slice(fee_recipient);
    data.extend_from_slice(mint_address);

    Sha256::hash(&data).map_err(|_| ProgramError::InvalidInstructionData)
}

pub fn ext_data_hash_matches(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
    Fr::from_le_bytes_mod_order(&calculated) == Fr::from_be_bytes_mod_order(&proof_hash)
}

pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
    if ext_amount == i64::MIN {
        return false;
    }

    let fee_fr = Fr::from(fee);
    let ext_amount_fr = if ext_amount >= 0 {
        Fr::from(ext_amount as u64)
    } else {
        let abs_ext_amount = match ext_amount.checked_neg() {
            Some(val) => val,
            None => return false,
        };
        Fr::from(abs_ext_amount as u64)
    };

    if ext_amount > 0 && ext_amount_fr <= fee_fr {
        return false;
    }

    let result_public_amount = if ext_amount >= 0 {
        ext_amount_fr - fee_fr
    } else {
        -(ext_amount_fr + fee_fr)
    };

    let provided_amount = Fr::from_be_bytes_mod_order(&public_amount_bytes);
    result_public_amount == provided_amount
}

pub fn verify_proof(proof: &Proof, verifying_key: &Groth16Verifyingkey) -> bool {
    let mut public_inputs_vec: [[u8; 32]; 7] = [[0u8; 32]; 7];

    public_inputs_vec[0] = proof.root;
    public_inputs_vec[1] = proof.public_amount;
    public_inputs_vec[2] = proof.ext_data_hash;
    public_inputs_vec[3] = proof.input_nullifiers[0];
    public_inputs_vec[4] = proof.input_nullifiers[1];
    public_inputs_vec[5] = proof.output_commitments[0];
    public_inputs_vec[6] = proof.output_commitments[1];

    // First deserialize PROOF_A into a G1 point (validates it is on-curve),
    // then negate it, as required by the pairing equation.
    let g1_point = match G1::deserialize_with_mode(
        &*[&change_endianness(&proof.proof_a[0..64]), &[0u8][..]].concat(),
        Compress::No,
        Validate::Yes,
    ) {
        Ok(point) => point,
        Err(_) => return false,
    };

    let mut proof_a_neg = [0u8; 65];
    if g1_point
        .neg()
        .x
        .serialize_with_mode(&mut proof_a_neg[..32], Compress::No)
        .is_err()
    {
        return false;
    }
    if g1_point
        .neg()
        .y
        .serialize_with_mode(&mut proof_a_neg[32..], Compress::No)
        .is_err()
    {
        return false;
    }

    let proof_a: [u8; 64] = match change_endianness(&proof_a_neg[..64]).try_into() {
        Ok(array) => array,
        Err(_) => return false,
    };

    let mut verifier = match Groth16Verifier::new(
        &proof_a,
        &proof.proof_b,
        &proof.proof_c,
        &public_inputs_vec,
        verifying_key,
    ) {
        Ok(v) => v,
        Err(_) => return false,
    };

    verifier.verify().unwrap_or(false)
}

pub fn change_endianness(bytes: &[u8]) -> Vec<u8> {
    let mut vec = Vec::new();
    for b in bytes.chunks(32) {
        for byte in b.iter().rev() {
            vec.push(*byte);
        }
    }
    vec
}



/// Verifying key for Transaction(26, 2, 3) — the batch payout circuit
/// (2 employees + change per proof). Generated from the batch3 ceremony zkey;
/// byte convention validated byte-for-byte against the production key above
/// (G2 pairs serialized c1-before-c0, big-endian limbs).
pub const VERIFYING_KEY_BATCH3: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: 8,
    vk_alpha_g1: [
        42, 197, 6, 75, 141, 233, 124, 40, 13, 210, 222, 81, 155, 195, 12, 156,
        230, 21, 160, 110, 182, 53, 123, 56, 76, 3, 115, 56, 176, 66, 181, 184,
        17, 213, 231, 149, 138, 102, 16, 162, 85, 10, 19, 183, 11, 94, 215, 185,
        142, 65, 77, 149, 67, 179, 114, 78, 185, 137, 122, 207, 116, 33, 235, 16,
    ],
    vk_beta_g2: [
        4, 215, 76, 13, 101, 179, 18, 181, 2, 210, 183, 207, 107, 71, 81, 215,
        76, 179, 41, 228, 134, 129, 96, 181, 33, 239, 141, 209, 149, 107, 135, 118,
        22, 249, 117, 174, 207, 42, 50, 6, 116, 181, 228, 32, 159, 175, 140, 147,
        135, 202, 97, 60, 230, 129, 142, 18, 193, 112, 196, 120, 177, 163, 171, 31,
        5, 100, 221, 229, 196, 189, 191, 225, 249, 102, 97, 239, 239, 124, 205, 86,
        20, 237, 235, 214, 124, 19, 193, 212, 229, 79, 181, 155, 224, 168, 250, 35,
        5, 165, 169, 41, 70, 117, 129, 184, 243, 213, 203, 64, 31, 30, 200, 174,
        76, 108, 227, 43, 162, 165, 52, 188, 146, 170, 84, 226, 106, 127, 212, 87,
    ],
    vk_gamme_g2: [
        25, 142, 147, 147, 146, 13, 72, 58, 114, 96, 191, 183, 49, 251, 93, 37,
        241, 170, 73, 51, 53, 169, 231, 18, 151, 228, 133, 183, 174, 243, 18, 194,
        24, 0, 222, 239, 18, 31, 30, 118, 66, 106, 0, 102, 94, 92, 68, 121,
        103, 67, 34, 212, 247, 94, 218, 221, 70, 222, 189, 92, 217, 146, 246, 237,
        9, 6, 137, 208, 88, 95, 240, 117, 236, 158, 153, 173, 105, 12, 51, 149,
        188, 75, 49, 51, 112, 179, 142, 243, 85, 172, 218, 220, 209, 34, 151, 91,
        18, 200, 94, 165, 219, 140, 109, 235, 74, 171, 113, 128, 141, 203, 64, 143,
        227, 209, 231, 105, 12, 67, 211, 123, 76, 230, 204, 1, 102, 250, 125, 170,
    ],
    vk_delta_g2: [
        25, 142, 147, 147, 146, 13, 72, 58, 114, 96, 191, 183, 49, 251, 93, 37,
        241, 170, 73, 51, 53, 169, 231, 18, 151, 228, 133, 183, 174, 243, 18, 194,
        24, 0, 222, 239, 18, 31, 30, 118, 66, 106, 0, 102, 94, 92, 68, 121,
        103, 67, 34, 212, 247, 94, 218, 221, 70, 222, 189, 92, 217, 146, 246, 237,
        9, 6, 137, 208, 88, 95, 240, 117, 236, 158, 153, 173, 105, 12, 51, 149,
        188, 75, 49, 51, 112, 179, 142, 243, 85, 172, 218, 220, 209, 34, 151, 91,
        18, 200, 94, 165, 219, 140, 109, 235, 74, 171, 113, 128, 141, 203, 64, 143,
        227, 209, 231, 105, 12, 67, 211, 123, 76, 230, 204, 1, 102, 250, 125, 170,
    ],
    vk_ic: &[
        [
            31, 206, 153, 114, 205, 163, 252, 243, 182, 80, 156, 67, 156, 183, 25, 13,
            152, 96, 231, 112, 147, 27, 67, 203, 48, 97, 157, 157, 202, 188, 93, 13,
            35, 30, 63, 170, 178, 248, 94, 177, 217, 19, 49, 162, 25, 114, 50, 236,
            195, 26, 208, 34, 187, 233, 239, 186, 2, 65, 197, 203, 187, 89, 79, 164,
        ],
        [
            27, 115, 249, 52, 185, 56, 8, 11, 220, 172, 6, 156, 233, 50, 19, 28,
            160, 28, 126, 115, 84, 194, 30, 221, 182, 106, 118, 133, 73, 225, 217, 221,
            9, 168, 92, 155, 150, 13, 14, 12, 242, 151, 53, 133, 38, 114, 233, 10,
            170, 79, 40, 253, 93, 108, 110, 105, 54, 190, 131, 69, 215, 49, 151, 66,
        ],
        [
            7, 149, 195, 212, 39, 53, 126, 116, 92, 211, 13, 235, 101, 13, 47, 119,
            27, 166, 151, 200, 219, 59, 93, 185, 185, 255, 51, 106, 77, 53, 49, 127,
            12, 253, 96, 175, 47, 246, 119, 96, 215, 244, 5, 243, 162, 104, 196, 71,
            157, 146, 89, 169, 2, 77, 186, 107, 250, 138, 96, 137, 39, 188, 142, 84,
        ],
        [
            30, 106, 122, 53, 47, 34, 50, 99, 195, 6, 254, 89, 96, 3, 236, 242,
            223, 45, 14, 17, 1, 179, 229, 55, 156, 100, 43, 78, 88, 81, 13, 32,
            1, 16, 96, 27, 193, 166, 186, 128, 217, 53, 103, 1, 170, 225, 242, 146,
            208, 222, 14, 48, 129, 64, 43, 95, 228, 191, 38, 216, 202, 193, 180, 90,
        ],
        [
            12, 119, 74, 152, 57, 50, 158, 165, 37, 0, 32, 61, 189, 161, 185, 99,
            167, 0, 80, 96, 71, 38, 103, 135, 6, 117, 222, 238, 75, 45, 95, 203,
            18, 72, 217, 25, 57, 227, 5, 211, 184, 173, 165, 169, 19, 214, 175, 101,
            226, 59, 78, 229, 68, 197, 215, 136, 114, 233, 144, 38, 165, 7, 77, 50,
        ],
        [
            43, 69, 139, 6, 26, 25, 118, 24, 183, 73, 156, 254, 82, 66, 121, 12,
            225, 125, 174, 114, 106, 229, 181, 93, 111, 133, 95, 161, 245, 155, 61, 138,
            17, 60, 179, 98, 42, 114, 141, 251, 178, 79, 97, 160, 223, 37, 36, 187,
            87, 251, 39, 160, 86, 175, 8, 196, 242, 98, 89, 159, 3, 22, 23, 53,
        ],
        [
            36, 248, 205, 63, 148, 233, 233, 62, 70, 171, 171, 101, 230, 83, 180, 147,
            205, 52, 2, 27, 75, 124, 2, 41, 152, 225, 17, 29, 157, 120, 100, 124,
            18, 95, 60, 22, 171, 99, 164, 90, 103, 190, 178, 212, 129, 236, 215, 214,
            104, 182, 46, 50, 244, 118, 212, 105, 38, 203, 41, 167, 33, 110, 231, 147,
        ],
        [
            12, 133, 208, 185, 117, 7, 100, 246, 76, 97, 11, 211, 87, 56, 185, 29,
            170, 141, 30, 35, 118, 13, 25, 49, 82, 228, 28, 9, 203, 60, 160, 78,
            42, 238, 125, 140, 20, 38, 206, 118, 3, 26, 88, 23, 35, 207, 155, 144,
            3, 224, 43, 238, 151, 40, 124, 133, 186, 206, 162, 212, 247, 200, 190, 78,
        ],
        [
            38, 188, 151, 18, 232, 56, 125, 203, 110, 123, 13, 134, 186, 241, 26, 91,
            63, 13, 50, 54, 78, 80, 10, 18, 103, 56, 61, 17, 255, 183, 166, 249,
            38, 188, 148, 153, 217, 135, 68, 186, 214, 235, 204, 116, 19, 54, 154, 171,
            193, 158, 48, 192, 168, 207, 127, 182, 143, 35, 51, 22, 242, 178, 9, 88,
        ],
    ],
};

/// ext_data_hash for batch payouts: same recipe as
/// calculate_complete_ext_data_hash but over 3 encrypted outputs.
pub fn calculate_complete_ext_data_hash_batch3(
    recipient: &[u8; 32],
    ext_amount: i64,
    encrypted_outputs: [&[u8]; 3],
    fee: u64,
    fee_recipient: &[u8; 32],
    mint_address: &[u8; 32],
) -> Result<[u8; 32], ProgramError> {
    let mut data = Vec::new();

    data.extend_from_slice(recipient);
    data.extend_from_slice(&ext_amount.to_le_bytes());
    for enc in encrypted_outputs {
        data.extend_from_slice(&(enc.len() as u32).to_le_bytes());
        data.extend_from_slice(enc);
    }
    data.extend_from_slice(&fee.to_le_bytes());
    data.extend_from_slice(fee_recipient);
    data.extend_from_slice(mint_address);

    Sha256::hash(&data).map_err(|_| ProgramError::InvalidInstructionData)
}

pub fn verify_proof_batch3(proof: &ProofBatch3, verifying_key: &Groth16Verifyingkey) -> bool {
    let mut public_inputs_vec: [[u8; 32]; 8] = [[0u8; 32]; 8];

    public_inputs_vec[0] = proof.root;
    public_inputs_vec[1] = proof.public_amount;
    public_inputs_vec[2] = proof.ext_data_hash;
    public_inputs_vec[3] = proof.input_nullifiers[0];
    public_inputs_vec[4] = proof.input_nullifiers[1];
    public_inputs_vec[5] = proof.output_commitments[0];
    public_inputs_vec[6] = proof.output_commitments[1];
    public_inputs_vec[7] = proof.output_commitments[2];

    let g1_point = match G1::deserialize_with_mode(
        &*[&change_endianness(&proof.proof_a[0..64]), &[0u8][..]].concat(),
        Compress::No,
        Validate::Yes,
    ) {
        Ok(point) => point,
        Err(_) => return false,
    };

    let mut proof_a_neg = [0u8; 65];
    if g1_point
        .neg()
        .x
        .serialize_with_mode(&mut proof_a_neg[..32], Compress::No)
        .is_err()
    {
        return false;
    }
    if g1_point
        .neg()
        .y
        .serialize_with_mode(&mut proof_a_neg[32..], Compress::No)
        .is_err()
    {
        return false;
    }

    let proof_a: [u8; 64] = match change_endianness(&proof_a_neg[..64]).try_into() {
        Ok(array) => array,
        Err(_) => return false,
    };

    let mut verifier = match Groth16Verifier::new(
        &proof_a,
        &proof.proof_b,
        &proof.proof_c,
        &public_inputs_vec,
        verifying_key,
    ) {
        Ok(v) => v,
        Err(_) => return false,
    };

    verifier.verify().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    #[test]
    fn test_verify_proof_rejects_garbage() {
        // proof_a of all zeros is not a valid on-curve G1 point, so
        // verification must fail before reaching the pairing.
        let mut proof = Proof::zeroed();
        proof.proof_a = [7u8; 64];
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

    #[test]
    fn test_verify_proof_rejects_zeroed_proof() {
        // The all-zero proof deserializes to the point at infinity; the
        // pairing check must still reject it.
        let proof = Proof::zeroed();
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    fn fr_to_be_bytes(f: Fr) -> [u8; 32] {
        let mut bytes = Vec::new();
        f.serialize_uncompressed(&mut bytes).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr.reverse();
        arr
    }

    #[test]
    fn transfer_ext_zero_with_fee_is_accepted() {
        let fee: u64 = 7;
        let public_amount = fr_to_be_bytes(-Fr::from(fee));
        assert!(check_public_amount(0, fee, public_amount));
    }

    #[test]
    fn transfer_ext_zero_fee_zero_is_accepted() {
        assert!(check_public_amount(0, 0, [0u8; 32]));
    }

    #[test]
    fn deposit_not_exceeding_fee_is_still_rejected() {
        assert!(!check_public_amount(5, 5, [0u8; 32]));
        assert!(!check_public_amount(5, 6, fr_to_be_bytes(Fr::from(5u64) - Fr::from(6u64))));
    }

    #[test]
    fn withdraw_with_matching_public_amount_is_accepted() {
        let ext_amount: i64 = -5;
        let fee: u64 = 1;
        let public_amount = fr_to_be_bytes(-(Fr::from(5u64) + Fr::from(fee)));
        assert!(check_public_amount(ext_amount, fee, public_amount));
    }
}
