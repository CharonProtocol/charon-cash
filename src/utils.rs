use crate::error::PrivacyCashError;
use crate::field::{lt_be, reduce_mod_r_be, sub_be, FQ_BE, FR_BE};
use crate::groth16::{Groth16Verifier, Groth16Verifyingkey};
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
    // `hashv` feeds the syscall the pieces directly, so the digest is
    // identical to hashing their concatenation but nothing is copied -- and
    // the encrypted outputs are the largest values in the instruction data.
    Sha256::hashv(&[
        recipient,
        &ext_amount.to_le_bytes(),
        &(encrypted_output1.len() as u32).to_le_bytes(),
        encrypted_output1,
        &(encrypted_output2.len() as u32).to_le_bytes(),
        encrypted_output2,
        &fee.to_le_bytes(),
        fee_recipient,
        mint_address,
    ])
    .map_err(|_| ProgramError::InvalidInstructionData)
}

/// Compares the recomputed ext-data hash against the one the proof commits to,
/// as scalar field elements.
///
/// The circuit consumes the SHA-256 digest little-endian, so reversing the
/// digest gives the big-endian integer it stands for; both sides are then
/// reduced mod `r` exactly as `Fr::from_*_bytes_mod_order` would.
pub fn ext_data_hash_matches(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
    let mut calculated_be = calculated;
    calculated_be.reverse();

    reduce_mod_r_be(&calculated_be) == reduce_mod_r_be(&proof_hash)
}

/// Checks that the proof's `public_amount` is the field element the transfer
/// parameters imply: `ext_amount - fee` for a deposit, `-(|ext_amount| + fee)`
/// for a withdrawal.
///
/// Both branches land far below `r`, so the expected element is laid out
/// directly as big-endian bytes -- a deposit is a `u64`, and a withdrawal is
/// `r` minus a value below `2^65`.
pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
    if ext_amount == i64::MIN {
        return false;
    }

    let expected = if ext_amount >= 0 {
        let deposit = ext_amount as u64;

        // A deposit that does not exceed its own fee produces nothing.
        if deposit <= fee {
            return false;
        }

        let mut bytes = [0u8; 32];
        bytes[24..].copy_from_slice(&(deposit - fee).to_be_bytes());
        bytes
    } else {
        // `|ext_amount| + fee < 2^65`, so the sum never reaches `r` and the
        // subtraction below cannot borrow.
        let total = ext_amount.unsigned_abs() as u128 + fee as u128;

        let mut bytes = [0u8; 32];
        bytes[16..].copy_from_slice(&total.to_be_bytes());

        match sub_be(&FR_BE, &bytes) {
            (negated, false) => negated,
            (_, true) => return false,
        }
    };

    expected == reduce_mod_r_be(&public_amount_bytes)
}

/// Negates a BN254 G1 point in the big-endian affine encoding `x || y` that
/// the `alt_bn128` syscalls and the proof both use.
///
/// Negation on an affine short-Weierstrass point is `(x, y) -> (x, q - y)`, so
/// the point never has to become a field element: one 256-bit subtraction
/// replaces a deserialization, four Montgomery conversions and a
/// re-serialization.
///
/// Nothing is validated here beyond what the negation itself needs.
/// `solana-bn254` deserializes every point it is handed and runs
/// `is_on_curve` before pairing, returning `GroupError` otherwise, so an
/// arkworks-side check would only fail marginally earlier.
///
/// Returns `None` for the two encodings that negation cannot handle:
///
/// - `y >= q` is not a field element, and wrapping the subtraction could turn
///   a rejected encoding into an accepted one.
/// - `y == 0` is never a curve point, because `y^2 = x^3 + 3` has no root at
///   zero: BN254's G1 has odd prime order and therefore no 2-torsion. It is
///   rejected explicitly rather than left to the syscall, since an all-zero
///   G1 encoding means the point at infinity there and would pair silently
///   instead of failing.
fn negate_g1_be(point: &[u8; 64]) -> Option<[u8; 64]> {
    let mut negated = *point;

    let y: [u8; 32] = point[32..64].try_into().ok()?;
    if y == [0u8; 32] || !lt_be(&y, &FQ_BE) {
        return None;
    }

    let (negated_y, borrow) = sub_be(&FQ_BE, &y);
    if borrow {
        return None;
    }
    negated[32..64].copy_from_slice(&negated_y);

    Some(negated)
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

    // The pairing equation needs -A.
    let proof_a = match negate_g1_be(&proof.proof_a) {
        Some(negated) => negated,
        None => return false,
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
    use ark_bn254::{Fq, Fr, G1Affine};
    use ark_ff::{BigInteger, PrimeField, UniformRand};
    use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
    use bytemuck::Zeroable;
    use core::ops::Neg;

    /// A deterministic byte stream, so failures reproduce.
    struct Lcg(u64);

    impl Lcg {
        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0
        }

        fn next_bytes(&mut self) -> [u8; 32] {
            let mut out = [0u8; 32];
            for chunk in out.chunks_mut(8) {
                chunk.copy_from_slice(&self.next_u64().to_be_bytes());
            }
            out
        }
    }

    /// The arkworks implementations these functions replaced, kept verbatim as
    /// the oracle the byte arithmetic is checked against.
    mod reference {
        use super::*;

        pub fn ext_data_hash_matches(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
            Fr::from_le_bytes_mod_order(&calculated) == Fr::from_be_bytes_mod_order(&proof_hash)
        }

        pub fn check_public_amount(
            ext_amount: i64,
            fee: u64,
            public_amount_bytes: [u8; 32],
        ) -> bool {
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

            if ext_amount >= 0 && ext_amount_fr <= fee_fr {
                return false;
            }

            let result_public_amount = if ext_amount >= 0 {
                ext_amount_fr - fee_fr
            } else {
                -(ext_amount_fr + fee_fr)
            };

            Fr::from_be_bytes_mod_order(&public_amount_bytes) == result_public_amount
        }

        /// The old `verify_proof` prologue: byte-swap, deserialize with a full
        /// on-curve check, negate, re-serialize, byte-swap back.
        pub fn negate_g1_be(point: &[u8; 64]) -> Option<[u8; 64]> {
            let g1 = G1Affine::deserialize_with_mode(
                &*[&change_endianness(&point[..64]), &[0u8][..]].concat(),
                Compress::No,
                Validate::Yes,
            )
            .ok()?;

            let mut negated_le = [0u8; 64];
            g1.neg()
                .x
                .serialize_with_mode(&mut negated_le[..32], Compress::No)
                .ok()?;
            g1.neg()
                .y
                .serialize_with_mode(&mut negated_le[32..], Compress::No)
                .ok()?;

            change_endianness(&negated_le).try_into().ok()
        }

        pub fn change_endianness(bytes: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            for chunk in bytes.chunks(32) {
                for byte in chunk.iter().rev() {
                    out.push(*byte);
                }
            }
            out
        }
    }

    fn g1_to_be_bytes(point: &G1Affine) -> [u8; 64] {
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&point.x.into_bigint().to_bytes_be());
        out[32..].copy_from_slice(&point.y.into_bigint().to_bytes_be());
        out
    }

    #[test]
    fn ext_data_hash_matches_agrees_with_arkworks() {
        let mut rng = Lcg(0x9e37_79b9_7f4a_7c15);

        for _ in 0..256 {
            let calculated = rng.next_bytes();
            let proof_hash = rng.next_bytes();

            // Overwhelmingly the mismatching case.
            assert_eq!(
                ext_data_hash_matches(calculated, proof_hash),
                reference::ext_data_hash_matches(calculated, proof_hash),
            );

            // And the matching one: the same element written both ways.
            let mut reversed = calculated;
            reversed.reverse();
            assert!(ext_data_hash_matches(calculated, reversed));
            assert!(reference::ext_data_hash_matches(calculated, reversed));
        }
    }

    #[test]
    fn check_public_amount_agrees_with_arkworks() {
        let mut rng = Lcg(0x0123_4567_89ab_cdef);

        let mut amounts = vec![0i64, 1, -1, 2, -2, i64::MAX, i64::MIN, i64::MIN + 1];
        let mut fees = vec![0u64, 1, 2, u64::MAX, u64::MAX - 1];
        for _ in 0..32 {
            amounts.push(rng.next_u64() as i64);
            fees.push(rng.next_u64());
        }

        for &ext_amount in &amounts {
            for &fee in &fees {
                // A `public_amount` that should be accepted, derived through
                // arkworks so the two paths cannot share a mistake.
                let expected: [u8; 32] = if ext_amount >= 0 {
                    (Fr::from(ext_amount as u64) - Fr::from(fee))
                        .into_bigint()
                        .to_bytes_be()
                        .try_into()
                        .unwrap()
                } else if ext_amount == i64::MIN {
                    [0u8; 32]
                } else {
                    (-(Fr::from(ext_amount.unsigned_abs()) + Fr::from(fee)))
                        .into_bigint()
                        .to_bytes_be()
                        .try_into()
                        .unwrap()
                };

                for candidate in [expected, rng.next_bytes(), [0u8; 32], [0xffu8; 32]] {
                    assert_eq!(
                        check_public_amount(ext_amount, fee, candidate),
                        reference::check_public_amount(ext_amount, fee, candidate),
                        "ext_amount {ext_amount}, fee {fee}, candidate {candidate:?}",
                    );
                }
            }
        }
    }

    #[test]
    fn negate_g1_be_agrees_with_arkworks_on_curve_points() {
        let mut rng = ark_std::test_rng();

        for _ in 0..64 {
            let point = G1Affine::rand(&mut rng);
            let bytes = g1_to_be_bytes(&point);

            assert_eq!(
                negate_g1_be(&bytes),
                reference::negate_g1_be(&bytes),
                "point {point}",
            );
            assert_eq!(negate_g1_be(&bytes).unwrap(), g1_to_be_bytes(&point.neg()));
        }
    }

    #[test]
    fn negate_g1_be_rejects_what_arkworks_rejected() {
        // y == 0 with a non-zero x: `y^2 = x^3 + 3` has no root at zero, so
        // arkworks failed the on-curve check here too.
        let mut zero_y = [0u8; 64];
        zero_y[31] = 7;
        assert!(negate_g1_be(&zero_y).is_none());
        assert!(reference::negate_g1_be(&zero_y).is_none());

        // y == q and y > q are not field elements, and arkworks refused to
        // deserialize them. Wrapping the subtraction instead of rejecting
        // would map y == q onto a zero y coordinate.
        let mut y_is_q = [0u8; 64];
        y_is_q[32..].copy_from_slice(&FQ_BE);
        assert!(negate_g1_be(&y_is_q).is_none());
        assert!(reference::negate_g1_be(&y_is_q).is_none());

        let mut y_above_q = [0xffu8; 64];
        y_above_q[..32].copy_from_slice(&Fq::from(3u64).into_bigint().to_bytes_be());
        assert!(negate_g1_be(&y_above_q).is_none());
        assert!(reference::negate_g1_be(&y_above_q).is_none());
    }

    /// The one place the byte path is stricter than the arkworks path it
    /// replaced.
    ///
    /// arkworks reads an all-zero G1 encoding as the point at infinity and
    /// negates it to itself, leaving the pairing to reject the proof.
    /// `negate_g1_be` rejects it outright, which skips a pointless pairing and
    /// keeps the point at infinity -- the one encoding the syscall accepts
    /// without an on-curve check -- off the verification path entirely.
    ///
    /// No honest proof is lost: `A` is the point at infinity only with
    /// negligible probability, and such a proof cannot satisfy the pairing
    /// equation anyway, since with `e(-A, B) == 1` nothing on the remaining
    /// side can cancel the `alpha * beta` term.
    #[test]
    fn negate_g1_be_rejects_the_point_at_infinity() {
        assert!(negate_g1_be(&[0u8; 64]).is_none());
        assert_eq!(reference::negate_g1_be(&[0u8; 64]), Some([0u8; 64]));

        // Either way `verify_proof` says no.
        let proof = Proof::zeroed();
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

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
