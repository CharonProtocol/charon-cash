use crate::error::PrivacyCashError;
use crate::groth16::{
    decompress_g1, decompress_g2, negate_g1, Groth16Verifier, Groth16Verifyingkey, FR_MODULUS_BE,
};
use crate::state::Proof;
use light_hasher::{Hasher, Sha256};
use pinocchio::error::ProgramError;

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

/// In-leg swap hash: dest mint, min-out, and both out-leg commitments.
pub fn calculate_swap_in_ext_data_hash(
    ext_amount_in: i64,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    in_mint: &[u8; 32],
    out_mint: &[u8; 32],
    ext_amount_out: i64,
    out_commitments: &[[u8; 32]; 2],
) -> Result<[u8; 32], ProgramError> {
    let mut data = Vec::new();
    data.extend_from_slice(crate::constants::SWAP_IN_DOMAIN);
    data.extend_from_slice(&ext_amount_in.to_le_bytes());
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);
    data.extend_from_slice(in_mint);
    data.extend_from_slice(out_mint);
    data.extend_from_slice(&ext_amount_out.to_le_bytes());
    data.extend_from_slice(&out_commitments[0]);
    data.extend_from_slice(&out_commitments[1]);
    Sha256::hash(&data).map_err(|_| ProgramError::InvalidInstructionData)
}

/// Out-leg swap hash. Deliberately does not mention the in-leg (no cycle).
pub fn calculate_swap_out_ext_data_hash(
    ext_amount_out: i64,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    out_mint: &[u8; 32],
) -> Result<[u8; 32], ProgramError> {
    let mut data = Vec::new();
    data.extend_from_slice(crate::constants::SWAP_OUT_DOMAIN);
    data.extend_from_slice(&ext_amount_out.to_le_bytes());
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);
    data.extend_from_slice(out_mint);
    Sha256::hash(&data).map_err(|_| ProgramError::InvalidInstructionData)
}

pub fn ext_data_hash_matches(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
    // SHA256 is interpreted little-endian in the circuit; the proof stores the
    // field element big-endian. Do the reduction with integer subtract so we
    // never rely on `num-bigint` on SBF (it disagrees with the host `% r`).
    fr_reduce_be(&swab32(&calculated)) == fr_reduce_be(&proof_hash)
}

fn swab32(bytes: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = bytes[31 - i];
    }
    out
}

fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> core::cmp::Ordering {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    core::cmp::Ordering::Equal
}

fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let av = a[i] as u16;
        let bv = b[i] as u16 + borrow;
        if av >= bv {
            out[i] = (av - bv) as u8;
            borrow = 0;
        } else {
            out[i] = (av + 256 - bv) as u8;
            borrow = 1;
        }
    }
    out
}

fn fr_reduce_be(bytes: &[u8; 32]) -> [u8; 32] {
    let mut x = *bytes;
    while cmp_be(&x, &FR_MODULUS_BE) != core::cmp::Ordering::Less {
        x = sub_be(&x, &FR_MODULUS_BE);
    }
    x
}

fn u64_to_be32(n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&n.to_be_bytes());
    out
}

pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
    if ext_amount == i64::MIN {
        return false;
    }

    // Shielded transfer: no public deposit/withdraw. Circuit public_amount is
    // `(ext - fee) mod Fr` = `-fee` (0 when fee is 0).
    if ext_amount == 0 {
        let expected = if fee == 0 {
            [0u8; 32]
        } else {
            sub_be(&FR_MODULUS_BE, &u64_to_be32(fee))
        };
        return fr_reduce_be(&public_amount_bytes) == expected;
    }

    let expected = if ext_amount > 0 {
        let ext_n = ext_amount as u64;
        if ext_n <= fee {
            return false;
        }
        u64_to_be32(ext_n - fee)
    } else {
        let abs_ext = match ext_amount.checked_neg() {
            Some(val) => val as u64,
            None => return false,
        };
        let sum = match abs_ext.checked_add(fee) {
            Some(v) => v,
            None => return false,
        };
        sub_be(&FR_MODULUS_BE, &u64_to_be32(sum))
    };

    fr_reduce_be(&public_amount_bytes) == expected
}

#[inline(never)]
pub fn verify_proof(proof: &Proof, verifying_key: &Groth16Verifyingkey) -> bool {
    let mut public_inputs_vec: [[u8; 32]; 7] = [[0u8; 32]; 7];

    public_inputs_vec[0] = proof.root;
    public_inputs_vec[1] = proof.public_amount;
    public_inputs_vec[2] = proof.ext_data_hash;
    public_inputs_vec[3] = proof.input_nullifiers[0];
    public_inputs_vec[4] = proof.input_nullifiers[1];
    public_inputs_vec[5] = proof.output_commitments[0];
    public_inputs_vec[6] = proof.output_commitments[1];

    let proof_a_uncomp = match decompress_g1(&proof.proof_a) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let proof_b_uncomp = match decompress_g2(&proof.proof_b) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let proof_c_uncomp = match decompress_g1(&proof.proof_c) {
        Ok(p) => p,
        Err(_) => return false,
    };

    let proof_a = negate_g1(&proof_a_uncomp);

    let mut verifier = match Groth16Verifier::new(
        &proof_a,
        &proof_b_uncomp,
        &proof_c_uncomp,
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
    use num_bigint::BigUint;

    fn fr_from_le_mod(bytes: &[u8; 32]) -> BigUint {
        let r = BigUint::from_bytes_be(&FR_MODULUS_BE);
        BigUint::from_bytes_le(bytes) % r
    }

    #[test]
    fn test_check_public_amount_shielded_transfer() {
        assert!(check_public_amount(0, 0, [0u8; 32]));
        assert!(!check_public_amount(0, 0, {
            let mut x = [0u8; 32];
            x[31] = 1;
            x
        }));
        let fee = 25u64;
        let expected = sub_be(&FR_MODULUS_BE, &u64_to_be32(fee));
        assert!(check_public_amount(0, fee, expected));
        assert!(!check_public_amount(1_000, 0, [0u8; 32]));
        assert!(check_public_amount(1_000, 0, u64_to_be32(1_000)));
    }

    #[test]
    fn test_proof_size_is_352() {
        assert_eq!(crate::state::transact::PROOF_SIZE, 352);
    }

    #[test]
    fn test_verify_proof_rejects_garbage() {
        // proof_a of all zeros is not a valid on-curve G1 point, so
        // verification must fail before reaching the pairing.
        let mut proof = Proof::zeroed();
        proof.proof_a = [7u8; 32];
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

    #[test]
    fn test_verify_proof_rejects_zeroed_proof() {
        // The all-zero proof deserializes to the point at infinity; the
        // pairing check must still reject it.
        let proof = Proof::zeroed();
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

    #[test]
    fn test_ext_data_hash_matches_le_be() {
        let calculated = {
            let mut c = [0u8; 32];
            c[0] = 7;
            c[15] = 9;
            c[31] = 3;
            c
        };
        let left = fr_from_le_mod(&calculated);
        let be = {
            let bytes = left.to_bytes_be();
            let mut out = [0u8; 32];
            out[32 - bytes.len()..].copy_from_slice(&bytes);
            out
        };
        assert!(ext_data_hash_matches(calculated, be));
        assert!(!ext_data_hash_matches(calculated, calculated));
    }

    #[test]
    fn test_swap_hashes_are_domain_separated() {
        let c0 = [1u8; 32];
        let c1 = [2u8; 32];
        let in_hash = calculate_swap_in_ext_data_hash(
            -1_000,
            b"in1",
            b"in2",
            &[3u8; 32],
            &[4u8; 32],
            900,
            &[c0, c1],
        )
        .unwrap();
        let out_hash = calculate_swap_out_ext_data_hash(900, b"out1", b"out2", &[4u8; 32]).unwrap();
        assert_ne!(in_hash, out_hash);
        let in_hash2 = calculate_swap_in_ext_data_hash(
            -1_000,
            b"in1",
            b"in2",
            &[3u8; 32],
            &[4u8; 32],
            900,
            &[c1, c0],
        )
        .unwrap();
        assert_ne!(in_hash, in_hash2);
    }
}
