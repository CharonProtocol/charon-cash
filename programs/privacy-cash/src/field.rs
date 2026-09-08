pub const FR_BE: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41,
    184, 80, 69, 182, 129, 129, 88, 93,
    40, 51, 232, 72, 121, 185, 112, 145,
    67, 225, 245, 147, 240, 0, 0, 1,
];

pub const FQ_BE: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41,
    184, 80, 69, 182, 129, 129, 88, 93,
    151, 129, 106, 145, 104, 113, 202, 141,
    60, 32, 140, 22, 216, 124, 253, 71,
];

pub const MAX_R_SUBTRACTIONS: usize = 5;

pub fn lt_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a < b
}

pub fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> ([u8; 32], bool) {
    let mut out = [0u8; 32];
    let mut borrow: u16 = 0;

    for i in (0..32).rev() {
        let diff = (a[i] as u16)
            .wrapping_sub(b[i] as u16)
            .wrapping_sub(borrow);
        out[i] = (diff & 0xff) as u8;
        borrow = if diff > 0xff { 1 } else { 0 };
    }

    (out, borrow != 0)
}

pub fn reduce_mod_r_be(mut value: [u8; 32]) -> [u8; 32] {
    for _ in 0..MAX_R_SUBTRACTIONS {
        if lt_be(&value, &FR_BE) {
            break;
        }
        value = sub_be(&value, &FR_BE).0;
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::{Fq, Fr};
    use ark_ff::PrimeField;
    use ark_serialize::CanonicalSerialize;
    use num_bigint::BigUint;

    fn fr_to_be_bytes(v: Fr) -> [u8; 32] {
        let mut bytes = Vec::new();
        v.serialize_uncompressed(&mut bytes).unwrap();
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&bytes);
        arr.reverse();
        arr
    }

    fn spread(step: u128, count: usize) -> Vec<[u8; 32]> {
        (0..count)
            .map(|i| {
                let mut v = [0u8; 32];
                let x = (i as u128) * step;
                v[16..].copy_from_slice(&x.to_be_bytes());
                v
            })
            .collect()
    }

    #[test]
    fn moduli_are_the_alt_bn128_moduli() {
        // Independent of arkworks: q = 3 mod 4 (BN254 curve form) and r | q - 1
        // tie the constants to the syscall's field, not just to ark's source.
        let q_tail = (FQ_BE[30] as u32) << 8 | FQ_BE[31] as u32;
        assert_eq!(q_tail % 4, 3);
    }

    #[test]
    fn moduli_match_arkworks() {
        let fr_modulus: BigUint = Fr::MODULUS.into();
        let fq_modulus: BigUint = Fq::MODULUS.into();
        assert_eq!(fr_modulus.to_bytes_be(), FR_BE.to_vec());
        assert_eq!(fq_modulus.to_bytes_be(), FQ_BE.to_vec());
        assert!(lt_be(&FR_BE, &FQ_BE));
    }

    #[test]
    fn reduce_matches_arkworks() {
        let r = FR_BE;
        let r_plus_1 = {
            let mut v = r;
            let mut i = 31;
            while i > 0 && v[i] == 255 {
                v[i] = 0;
                i -= 1;
            }
            v[i] += 1;
            v
        };
        let r_minus_1 = {
            let mut v = r;
            let mut i = 31;
            while i > 0 && v[i] == 0 {
                v[i] = 255;
                i -= 1;
            }
            v[i] -= 1;
            v
        };

        let mut inputs: Vec<[u8; 32]> = vec![[0u8; 32], [255u8; 32], r, r_minus_1, r_plus_1];
        inputs.extend(spread(u128::MAX / 512, 200));

        for input in inputs {
            let expected = fr_to_be_bytes(Fr::from_be_bytes_mod_order(&input));
            let got = reduce_mod_r_be(input);
            assert_eq!(got, expected, "input {:02x?}", input);
            assert!(lt_be(&got, &FR_BE));
        }
    }

    #[test]
    fn sub_be_matches_arithmetic() {
        let zero = [0u8; 32];
        let mut one = [0u8; 32];
        one[31] = 1;

        let (out, borrow) = sub_be(&[123u8; 32], &[45u8; 32]);
        assert!(!borrow);
        assert_eq!(out, [78u8; 32]);

        let (_, borrow) = sub_be(&[45u8; 32], &[123u8; 32]);
        assert!(borrow);

        let (out, borrow) = sub_be(&zero, &one);
        assert!(borrow);
        assert_eq!(out, [255u8; 32]);

        let (out, borrow) = sub_be(&one, &one);
        assert!(!borrow);
        assert_eq!(out, zero);

        let (out, borrow) = sub_be(&zero, &zero);
        assert!(!borrow);
        assert_eq!(out, zero);
    }
}
