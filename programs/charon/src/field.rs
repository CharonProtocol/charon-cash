//! Fixed-width big-endian arithmetic over the two BN254 fields.
//!
//! Everything this program does with field elements is one of three things:
//! compare a 32-byte value against a modulus, reduce a 32-byte value modulo
//! the scalar field, or negate a base-field element. None of them needs a
//! field type, a bignum allocation, or a Montgomery representation, all of
//! which are expensive on SBF because it has no 64x64 -> 128 multiply.
//!
//! All values here are 256-bit unsigned integers in big-endian byte order,
//! which is the encoding the `alt_bn128` syscalls and the proof accept.

/// BN254 base field modulus `q`, big-endian.
///
/// `21888242871839275222246405745257275088696311157297823662689037894645226208583`
pub const FQ_BE: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 151, 129, 106, 145,
    104, 113, 202, 141, 60, 32, 140, 22, 216, 124, 253, 71,
];

/// BN254 scalar field modulus `r`, big-endian.
///
/// `21888242871839275222246405745257275088548364400416034343698204186575808495617`
pub const FR_BE: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 40, 51, 232, 72, 121,
    185, 112, 145, 67, 225, 245, 147, 240, 0, 0, 1,
];

/// `2^256 / r == 5`, so any 256-bit value is brought below `r` by at most five
/// subtractions of `r`.
const MAX_R_SUBTRACTIONS: usize = 5;

/// `a < b`, comparing two 256-bit big-endian values.
#[inline]
pub const fn lt_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
        i += 1;
    }
    false
}

/// `a - b` over 256-bit big-endian values.
///
/// Returns the wrapped difference and whether the subtraction borrowed, i.e.
/// whether `a < b`. Callers that need a real difference must check the flag.
#[inline]
pub fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> ([u8; 32], bool) {
    let mut out = [0u8; 32];
    let mut borrow = 0u16;

    let mut i = 32;
    while i > 0 {
        i -= 1;
        let d = (a[i] as u16)
            .wrapping_sub(b[i] as u16)
            .wrapping_sub(borrow);
        out[i] = d as u8;
        borrow = (d >> 8) & 1;
    }

    (out, borrow == 1)
}

/// Reduces a 256-bit big-endian value modulo the scalar field.
///
/// This is the byte-level equivalent of `Fr::from_be_bytes_mod_order`, minus
/// the Montgomery conversion, which is unobservable when the only thing done
/// with the result is comparing it to another reduced value.
#[inline]
pub fn reduce_mod_r_be(value: &[u8; 32]) -> [u8; 32] {
    let mut out = *value;

    let mut i = 0;
    while i < MAX_R_SUBTRACTIONS {
        let (difference, borrow) = sub_be(&out, &FR_BE);
        if borrow {
            break;
        }
        out = difference;
        i += 1;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::{Fq, Fr};
    use ark_ff::{BigInteger, PrimeField};

    fn fr_be(bytes: &[u8; 32]) -> [u8; 32] {
        Fr::from_be_bytes_mod_order(bytes)
            .into_bigint()
            .to_bytes_be()
            .try_into()
            .unwrap()
    }

    #[test]
    fn moduli_match_arkworks() {
        assert_eq!(FR_BE.to_vec(), Fr::MODULUS.to_bytes_be());
        assert_eq!(FQ_BE.to_vec(), Fq::MODULUS.to_bytes_be());
    }

    #[test]
    fn lt_be_matches_integer_order() {
        assert!(lt_be(&[0u8; 32], &FR_BE));
        assert!(!lt_be(&FR_BE, &FR_BE));
        assert!(!lt_be(&[0xffu8; 32], &FR_BE));

        let mut r_minus_one = FR_BE;
        r_minus_one[31] -= 1;
        assert!(lt_be(&r_minus_one, &FR_BE));

        let mut r_plus_one = FR_BE;
        r_plus_one[31] += 1;
        assert!(!lt_be(&r_plus_one, &FR_BE));
    }

    #[test]
    fn sub_be_borrows_exactly_when_smaller() {
        let (difference, borrow) = sub_be(&FR_BE, &FR_BE);
        assert!(!borrow);
        assert_eq!(difference, [0u8; 32]);

        let (_, borrow) = sub_be(&[0u8; 32], &[0u8; 32]);
        assert!(!borrow);

        let mut one = [0u8; 32];
        one[31] = 1;
        let (difference, borrow) = sub_be(&[0u8; 32], &one);
        assert!(borrow);
        assert_eq!(difference, [0xffu8; 32]);

        // Borrow propagates the whole way across the word.
        let mut big = [0u8; 32];
        big[0] = 1;
        let (difference, borrow) = sub_be(&big, &one);
        assert!(!borrow);
        let mut expected = [0xffu8; 32];
        expected[0] = 0;
        assert_eq!(difference, expected);
    }

    #[test]
    fn reduce_mod_r_matches_arkworks() {
        let mut cases = vec![
            [0u8; 32],
            [0xffu8; 32],
            FR_BE,
            {
                let mut v = FR_BE;
                v[31] -= 1;
                v
            },
            {
                let mut v = FR_BE;
                v[31] += 1;
                v
            },
        ];

        // A deterministic spread of values across the whole 256-bit range,
        // including the top of it where five subtractions are needed.
        let mut state = 0x243f_6a88_85a3_08d3u64;
        for _ in 0..512 {
            let mut value = [0u8; 32];
            for chunk in value.chunks_mut(8) {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                chunk.copy_from_slice(&state.to_be_bytes());
            }
            cases.push(value);
        }

        for case in cases {
            assert_eq!(reduce_mod_r_be(&case), fr_be(&case), "case {case:?}");
            assert!(lt_be(&reduce_mod_r_be(&case), &FR_BE));
        }
    }
}
