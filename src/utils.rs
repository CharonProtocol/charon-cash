use crate::error::PrivacyCashError;
use crate::groth16::{Groth16Verifier, Groth16Verifyingkey, FR_MODULUS_BE};
use crate::state::Proof;
use light_hasher::{Hasher, Sha256};
use pinocchio::error::ProgramError;

/// BN254 base field modulus q (Fq), big-endian.
/// 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47
const FQ_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
    0x5d, 0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c,
    0xfd, 0x47,
];

/// a - b for 32-byte big-endian integers. Caller guarantees a >= b.
fn be_sub_32(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let diff = 0x100 + a[i] as u16 - b[i] as u16 - borrow;
        out[i] = diff as u8;
        borrow = 1 - (diff >> 8);
    }
    out
}

/// Reduce a 256-bit big-endian integer mod r. 2^256 / r ≈ 5.3, so the loop
/// runs at most 5 times.
fn reduce_mod_fr_be(mut bytes: [u8; 32]) -> [u8; 32] {
    while &bytes >= &FR_MODULUS_BE {
        bytes = be_sub_32(&bytes, &FR_MODULUS_BE);
    }
    bytes
}

/// Negate a big-endian-encoded G1 point: y' = q - y on bytes 32..64.
///
/// y == 0 is left unchanged: it covers the all-zero point-at-infinity
/// encoding, and (x != 0, y = 0) is never on-curve for BN254 G1, so the
/// pairing syscall rejects it. Returns None for non-canonical y >= q
/// (the syscall would reject those too; checking here keeps the failure
/// in-program, as before).
fn negate_g1_be(point: &[u8; 64]) -> Option<[u8; 64]> {
    let y: &[u8; 32] = point[32..64].try_into().unwrap();
    if y >= &FQ_MODULUS_BE {
        return None;
    }
    let mut out = *point;
    if y != &[0u8; 32] {
        out[32..64].copy_from_slice(&be_sub_32(&FQ_MODULUS_BE, y));
    }
    Some(out)
}

fn u128_to_be_32(v: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&v.to_be_bytes());
    out
}

pub const VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey {
	nr_pubinputs: 7,

	vk_alpha_g1: [
		45,77,154,167,227,2,217,223,65,116,157,85,7,148,157,5,219,234,51,251,177,108,100,59,34,245,153,162,190,109,242,226,
		20,190,221,80,60,55,206,176,97,216,236,96,32,159,227,69,206,137,131,10,25,35,3,1,240,118,202,255,0,77,25,38,
	],

	vk_beta_g2: [
		9,103,3,47,203,247,118,209,175,201,133,248,136,119,241,130,211,132,128,166,83,242,222,202,169,121,76,188,59,243,6,12,
		14,24,120,71,173,76,121,131,116,208,214,115,43,245,1,132,125,214,139,192,224,113,36,30,2,19,188,127,193,61,183,171,
		48,76,251,209,224,138,112,74,153,245,232,71,217,63,140,60,170,253,222,196,107,122,13,55,157,166,154,77,17,35,70,167,
		23,57,193,177,164,87,168,199,49,49,35,210,77,47,145,146,248,150,183,198,62,234,5,169,213,127,6,84,122,208,206,200,
	],

	vk_gamme_g2: [
		25,142,147,147,146,13,72,58,114,96,191,183,49,251,93,37,241,170,73,51,53,169,231,18,151,228,133,183,174,243,18,194,
		24,0,222,239,18,31,30,118,66,106,0,102,94,92,68,121,103,67,34,212,247,94,218,221,70,222,189,92,217,146,246,237,
		9,6,137,208,88,95,240,117,236,158,153,173,105,12,51,149,188,75,49,51,112,179,142,243,85,172,218,220,209,34,151,91,
		18,200,94,165,219,140,109,235,74,171,113,128,141,203,64,143,227,209,231,105,12,67,211,123,76,230,204,1,102,250,125,170,
	],

	vk_delta_g2: [
		25,252,204,73,0,218,132,40,192,175,106,179,247,34,6,163,111,68,46,211,76,146,16,158,28,23,146,254,157,94,7,92,
		34,128,9,143,49,11,128,172,203,141,109,166,180,82,110,179,223,71,56,138,77,154,73,160,146,198,203,125,196,135,167,56,
		21,152,106,224,184,3,47,85,250,118,220,185,175,242,111,30,40,24,69,173,252,13,109,1,241,162,122,76,24,38,72,88,
		45,118,91,197,236,236,152,29,29,233,108,250,155,255,230,156,182,159,1,3,41,60,40,136,181,220,23,150,130,211,23,83,
	],

	vk_ic: &[
		[
			35,121,23,162,32,101,247,115,177,199,50,158,3,60,188,95,91,29,121,210,53,155,245,226,203,245,186,167,39,32,160,202,
			22,22,168,160,125,45,56,45,132,214,20,198,76,81,2,150,0,61,86,130,105,170,141,244,13,180,81,79,18,166,129,129,
		],
		[
			13,148,63,234,185,42,3,159,127,24,240,200,72,24,176,7,181,215,212,52,13,160,172,182,177,22,235,4,173,229,25,108,
			46,61,233,184,181,152,132,103,252,100,229,144,217,36,39,254,67,237,70,214,192,231,140,86,113,40,11,88,12,150,157,226,
		],
		[
			26,105,150,204,178,202,26,62,39,178,179,225,133,140,138,40,60,187,99,57,237,7,203,159,251,103,46,207,219,186,19,64,
			0,42,73,5,76,48,115,80,96,29,197,213,228,240,7,144,140,3,127,89,87,247,98,153,174,81,7,158,183,80,139,147,
		],
		[
			6,249,88,104,56,74,144,136,129,176,70,216,18,147,78,141,24,93,95,242,68,49,215,152,246,110,151,241,228,59,230,187,
			29,56,186,210,200,190,93,64,110,0,55,105,166,104,208,46,82,81,146,136,179,99,104,232,99,248,162,137,21,217,220,77,
		],
		[
			34,163,170,91,254,215,220,175,71,67,56,43,178,48,92,7,170,124,201,232,207,202,134,80,123,31,26,236,76,175,186,155,
			46,253,236,170,12,248,30,127,51,136,100,51,34,7,218,21,133,51,148,235,92,210,117,134,121,78,166,90,10,194,193,148,
		],
		[
			36,180,82,206,231,195,86,41,106,145,21,107,234,233,139,225,54,131,165,186,77,127,180,146,240,188,64,37,52,96,13,163,
			24,163,180,194,36,190,184,250,134,211,189,81,228,125,4,21,20,20,255,26,142,105,230,174,244,121,184,65,9,40,77,148,
		],
		[
			11,24,12,201,201,217,179,163,6,167,37,40,172,236,81,246,31,38,112,17,100,163,111,57,31,198,231,63,224,178,38,76,
			12,154,160,41,58,177,5,197,223,113,12,75,237,239,9,40,178,44,222,130,125,221,142,241,213,58,131,242,120,108,213,163,
		],
		[
			1,83,134,187,30,49,61,118,206,110,225,192,155,101,155,204,202,49,229,41,148,232,24,47,85,47,108,99,113,12,209,88,
			41,144,185,30,176,46,190,244,148,151,142,64,45,22,16,17,48,122,183,81,187,18,142,10,230,78,6,42,245,140,166,121,
		],
	]
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
    recipient: [u8; 32],
    ext_amount: i64,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    fee: u64,
    fee_recipient: [u8; 32],
    mint_address: [u8; 32],
) -> Result<[u8; 32], ProgramError> {
    let mut data = Vec::new();

    data.extend_from_slice(&recipient);
    data.extend_from_slice(&ext_amount.to_le_bytes());
    data.extend_from_slice(&(encrypted_output1.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output1);
    data.extend_from_slice(&(encrypted_output2.len() as u32).to_le_bytes());
    data.extend_from_slice(encrypted_output2);
    data.extend_from_slice(&fee.to_le_bytes());
    data.extend_from_slice(&fee_recipient);
    data.extend_from_slice(&mint_address);

    Sha256::hash(&data).map_err(|_| ProgramError::InvalidInstructionData)
}

pub fn ext_data_hash_matches(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
    // The calculated hash is interpreted little-endian, the proof's
    // big-endian; both are compared as field elements mod r (matching the
    // original's Fr::from_le_bytes_mod_order == Fr::from_be_bytes_mod_order).
    let mut calc_be = calculated;
    calc_be.reverse();
    reduce_mod_fr_be(calc_be) == reduce_mod_fr_be(proof_hash)
}

pub fn check_public_amount(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
    if ext_amount == i64::MIN {
        return false;
    }

    let expected = if ext_amount >= 0 {
        let ext = ext_amount as u64;
        // Deposits must be strictly larger than the fee (ext == 0 included).
        if ext <= fee {
            return false;
        }
        u128_to_be_32((ext - fee) as u128)
    } else {
        // -(|ext| + fee) mod r == r - (|ext| + fee); the sum can exceed u64
        // but is < 2^65 << r, and is >= 1, so no further reduction is needed.
        let sum = ext_amount.unsigned_abs() as u128 + fee as u128;
        be_sub_32(&FR_MODULUS_BE, &u128_to_be_32(sum))
    };

    expected == reduce_mod_fr_be(public_amount_bytes)
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

    // Negate proof_a in place (y' = q - y), as required by the pairing
    // equation. On-curve validation happens inside the pairing syscall, which
    // errors on invalid points and makes verification return false. Note: an
    // all-zero proof_a is accepted by the syscall as the point at infinity
    // (the previous ark deserialization rejected it in-program) and is then
    // rejected by the pairing-product check — same result, matching upstream
    // Light Protocol behavior.
    let Some(proof_a) = negate_g1_be(&proof.proof_a) else {
        return false;
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
    use crate::groth16::is_less_than_bn254_field_size_be;
    use ark_bn254::{Fr, G1Affine};
    use ark_ec::{AffineRepr, CurveGroup};
    use ark_ff::{BigInteger, PrimeField};
    use bytemuck::Zeroable;
    use num_bigint::BigUint;

    fn fr_to_be_32(fr: Fr) -> [u8; 32] {
        fr.into_bigint().to_bytes_be().try_into().unwrap()
    }

    fn biguint_to_be_32(v: &BigUint) -> [u8; 32] {
        let bytes = v.to_bytes_be();
        assert!(bytes.len() <= 32);
        let mut out = [0u8; 32];
        out[32 - bytes.len()..].copy_from_slice(&bytes);
        out
    }

    fn g1_to_be_64(p: &G1Affine) -> [u8; 64] {
        let mut out = [0u8; 64];
        if !p.infinity {
            out[..32].copy_from_slice(&p.x.into_bigint().to_bytes_be());
            out[32..].copy_from_slice(&p.y.into_bigint().to_bytes_be());
        }
        out
    }

    /// Deterministic pseudorandom bytes (xorshift) so tests need no rand dep.
    fn pseudorandom_32(seed: &mut u64) -> [u8; 32] {
        let mut out = [0u8; 32];
        for chunk in out.chunks_mut(8) {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            chunk.copy_from_slice(&seed.to_be_bytes());
        }
        out
    }

    #[test]
    fn test_verify_proof_rejects_garbage() {
        // proof_a of all sevens is not a valid on-curve G1 point; the pairing
        // syscall rejects it and verification must fail.
        let mut proof = Proof::zeroed();
        proof.proof_a = [7u8; 64];
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

    #[test]
    fn test_verify_proof_rejects_zeroed_proof() {
        // The all-zero proof encodes the point at infinity, which the pairing
        // syscall accepts as input; the pairing-product check must still
        // reject the proof.
        let proof = Proof::zeroed();
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

    /// A valid proof generated with snarkjs against the production
    /// transaction2.zkey/wasm from privacy-cash-orignal/artifacts/circuits
    /// (deposit of publicAmount=100, two zero-amount dummy inputs). It runs
    /// the full verify_proof path on the host: solana-bn254's non-solana
    /// target executes real ark pairings instead of syscalls.
    fn valid_proof_fixture() -> Proof {
        const PROOF_A: [u8; 64] = [38,220,161,227,233,88,227,215,161,119,206,79,90,225,105,178,239,3,103,255,111,11,238,94,6,63,188,13,113,239,15,177,22,208,143,60,223,194,114,204,243,239,28,40,182,229,58,165,78,151,100,243,47,0,151,52,192,18,142,19,149,94,68,235];
        const PROOF_B: [u8; 128] = [42,211,128,149,115,104,201,127,47,50,196,140,154,220,101,187,47,34,252,89,6,234,115,138,126,121,62,21,109,41,175,47,1,105,160,211,94,119,107,170,92,19,80,222,97,167,155,26,29,116,9,133,179,74,179,92,245,177,201,148,160,125,46,101,7,57,106,15,207,232,56,36,84,236,51,66,138,26,8,126,168,171,49,98,169,92,132,204,58,189,194,241,121,126,234,254,13,221,183,178,179,27,198,170,156,143,77,87,242,39,233,132,117,20,71,64,87,143,211,156,93,189,103,43,255,218,24,69];
        const PROOF_C: [u8; 64] = [15,138,110,43,124,104,20,171,203,49,113,78,95,2,149,181,87,162,136,68,243,28,97,39,110,170,89,211,217,42,24,117,47,114,78,5,184,15,72,251,247,217,217,160,150,43,38,80,209,222,181,80,239,44,192,150,177,131,191,83,133,196,154,47];
        const ROOT: [u8; 32] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,42];
        const PUBLIC_AMOUNT: [u8; 32] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,100];
        const EXT_DATA_HASH: [u8; 32] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,48,57];
        const NULLIFIER_0: [u8; 32] = [37,153,182,104,41,232,21,174,137,122,198,7,250,172,173,254,74,76,162,192,173,185,120,221,6,190,219,244,81,12,99,85];
        const NULLIFIER_1: [u8; 32] = [20,104,248,161,252,84,29,160,152,56,53,145,221,119,193,100,225,181,20,201,131,78,247,9,43,138,142,182,117,179,127,9];
        const COMMITMENT_0: [u8; 32] = [0,11,198,70,122,21,21,49,98,10,45,239,39,31,4,22,134,101,197,36,1,231,136,59,13,56,206,45,0,77,73,118];
        const COMMITMENT_1: [u8; 32] = [9,205,58,207,161,212,208,179,135,15,58,121,140,65,42,42,74,180,96,6,162,186,75,160,116,30,126,127,169,228,222,144];
        Proof {
            proof_a: PROOF_A,
            proof_b: PROOF_B,
            proof_c: PROOF_C,
            root: ROOT,
            public_amount: PUBLIC_AMOUNT,
            ext_data_hash: EXT_DATA_HASH,
            input_nullifiers: [NULLIFIER_0, NULLIFIER_1],
            output_commitments: [COMMITMENT_0, COMMITMENT_1],
        }
    }

    #[test]
    fn test_verify_proof_accepts_valid_proof() {
        assert!(verify_proof(&valid_proof_fixture(), &VERIFYING_KEY));
    }

    #[test]
    fn test_verify_proof_rejects_tampered_valid_proof() {
        // Any single-byte change to a public input must break verification.
        let mut proof = valid_proof_fixture();
        proof.public_amount[31] = 101;
        assert!(!verify_proof(&proof, &VERIFYING_KEY));

        let mut proof = valid_proof_fixture();
        proof.input_nullifiers[0][31] ^= 1;
        assert!(!verify_proof(&proof, &VERIFYING_KEY));

        // Swapping proofs across sections must also fail.
        let mut proof = valid_proof_fixture();
        proof.proof_c = proof.proof_a;
        assert!(!verify_proof(&proof, &VERIFYING_KEY));
    }

    #[test]
    fn test_negate_g1_matches_ark() {
        for k in [1u64, 2, 3, 42, 1337, u64::MAX] {
            let p = (G1Affine::generator() * Fr::from(k)).into_affine();
            let expected = g1_to_be_64(&(-p));
            assert_eq!(negate_g1_be(&g1_to_be_64(&p)).unwrap(), expected);
        }
    }

    #[test]
    fn test_negate_g1_edge_cases() {
        // Point at infinity (all zero) is unchanged.
        assert_eq!(negate_g1_be(&[0u8; 64]), Some([0u8; 64]));

        // y == q - 1 negates to y' == 1.
        let mut point = [0u8; 64];
        point[..32].copy_from_slice(&[5u8; 32]);
        let q_minus_1 = be_sub_32(&FQ_MODULUS_BE, &biguint_to_be_32(&BigUint::from(1u8)));
        point[32..].copy_from_slice(&q_minus_1);
        let negated = negate_g1_be(&point).unwrap();
        assert_eq!(negated[..32], point[..32]);
        assert_eq!(negated[32..], biguint_to_be_32(&BigUint::from(1u8)));

        // Non-canonical y >= q is rejected.
        point[32..].copy_from_slice(&FQ_MODULUS_BE);
        assert_eq!(negate_g1_be(&point), None);
        point[32..].copy_from_slice(&[0xffu8; 32]);
        assert_eq!(negate_g1_be(&point), None);
    }

    #[test]
    fn test_reduce_mod_fr_matches_ark() {
        let r = BigUint::from_bytes_be(&FR_MODULUS_BE);
        let mut cases: Vec<[u8; 32]> = vec![
            [0u8; 32],
            biguint_to_be_32(&BigUint::from(1u8)),
            biguint_to_be_32(&(&r - 1u8)),
            FR_MODULUS_BE,
            biguint_to_be_32(&(&r + 1u8)),
            biguint_to_be_32(&(&r * 2u8)),
            biguint_to_be_32(&(&r * 5u8 + 7u8)),
            [0xffu8; 32],
        ];
        let mut seed = 0x9e3779b97f4a7c15u64;
        cases.extend((0..64).map(|_| pseudorandom_32(&mut seed)));

        for bytes in cases {
            assert_eq!(
                reduce_mod_fr_be(bytes),
                fr_to_be_32(Fr::from_be_bytes_mod_order(&bytes)),
                "mismatch for input {bytes:02x?}"
            );
        }
    }

    #[test]
    fn test_field_size_check_boundaries() {
        let r = BigUint::from_bytes_be(&FR_MODULUS_BE);
        assert!(is_less_than_bn254_field_size_be(&[0u8; 32]));
        assert!(is_less_than_bn254_field_size_be(&biguint_to_be_32(&(&r - 1u8))));
        assert!(!is_less_than_bn254_field_size_be(&FR_MODULUS_BE));
        assert!(!is_less_than_bn254_field_size_be(&biguint_to_be_32(&(&r + 1u8))));
        assert!(!is_less_than_bn254_field_size_be(&[0xffu8; 32]));
    }

    /// The original ark-based implementation, kept for differential testing.
    fn check_public_amount_ark(ext_amount: i64, fee: u64, public_amount_bytes: [u8; 32]) -> bool {
        if ext_amount == i64::MIN {
            return false;
        }
        let fee_fr = Fr::from(fee);
        let ext_amount_fr = if ext_amount >= 0 {
            Fr::from(ext_amount as u64)
        } else {
            Fr::from(ext_amount.unsigned_abs())
        };
        if ext_amount >= 0 && ext_amount_fr <= fee_fr {
            return false;
        }
        let result_public_amount = if ext_amount >= 0 {
            ext_amount_fr - fee_fr
        } else {
            -(ext_amount_fr + fee_fr)
        };
        result_public_amount == Fr::from_be_bytes_mod_order(&public_amount_bytes)
    }

    #[test]
    fn test_check_public_amount_matches_ark() {
        let r = BigUint::from_bytes_be(&FR_MODULUS_BE);
        let ext_amounts = [i64::MIN, i64::MIN + 1, -i64::MAX, -1_000_000, -1, 0, 1, 999, 1000, 1001, 1_000_000, i64::MAX];
        let fees = [0u64, 1, 999, 1000, 1001, u64::MAX];
        let mut seed = 0xdeadbeefcafef00du64;

        for &ext in &ext_amounts {
            for &fee in &fees {
                // Candidate public_amount values: the ark-correct one, the
                // same shifted by +r (mod-order alias), and noise.
                let correct = if ext == i64::MIN {
                    [0u8; 32]
                } else {
                    let ext_fr = if ext >= 0 {
                        Fr::from(ext as u64) - Fr::from(fee)
                    } else {
                        -(Fr::from(ext.unsigned_abs()) + Fr::from(fee))
                    };
                    fr_to_be_32(ext_fr)
                };
                let aliased = biguint_to_be_32(&((BigUint::from_bytes_be(&correct) + &r) % (BigUint::from(1u8) << 256)));
                for candidate in [correct, aliased, [0u8; 32], pseudorandom_32(&mut seed)] {
                    assert_eq!(
                        check_public_amount(ext, fee, candidate),
                        check_public_amount_ark(ext, fee, candidate),
                        "mismatch for ext={ext} fee={fee} candidate={candidate:02x?}"
                    );
                }
            }
        }
    }

    /// The original ark-based implementation, kept for differential testing.
    fn ext_data_hash_matches_ark(calculated: [u8; 32], proof_hash: [u8; 32]) -> bool {
        Fr::from_le_bytes_mod_order(&calculated) == Fr::from_be_bytes_mod_order(&proof_hash)
    }

    #[test]
    fn test_ext_data_hash_matches_ark() {
        let mut seed = 0x123456789abcdef1u64;
        for _ in 0..64 {
            let calculated = pseudorandom_32(&mut seed);
            // Matching pair: proof hash is the BE reduction of the LE value.
            let matching = fr_to_be_32(Fr::from_le_bytes_mod_order(&calculated));
            let mismatching = pseudorandom_32(&mut seed);
            for proof_hash in [matching, mismatching] {
                assert_eq!(
                    ext_data_hash_matches(calculated, proof_hash),
                    ext_data_hash_matches_ark(calculated, proof_hash),
                    "mismatch for calculated={calculated:02x?} proof_hash={proof_hash:02x?}"
                );
            }
            assert!(ext_data_hash_matches(calculated, matching));
        }
    }
}
