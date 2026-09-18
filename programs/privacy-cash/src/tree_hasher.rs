//! Opt-in benchmark backend. Poseidon2 roots are incompatible with the committed
//! Circom circuit and existing accounts. Never deploy this experimental feature.
#[cfg(not(feature = "experimental-poseidon2"))]
pub use light_hasher::Poseidon as TreeHasher;

#[cfg(feature = "experimental-poseidon2")]
pub use experimental::Poseidon2 as TreeHasher;

#[cfg(feature = "experimental-poseidon2")]
mod experimental {
    use light_hasher::{zero_bytes::ZeroBytes, Hash, Hasher, HasherError};
    use solana_poseidon2::{horizen, FieldElement};
    include!(concat!(env!("OUT_DIR"), "/poseidon2_zeros.rs"));

    pub struct Poseidon2;
    impl Hasher for Poseidon2 {
        const ID: u8 = 254;
        fn hash(_value: &[u8]) -> Result<Hash, HasherError> {
            Err(HasherError::InvalidNumFields)
        }
        fn hashv(values: &[&[u8]]) -> Result<Hash, HasherError> {
            if values.len() != 2 {
                return Err(HasherError::InvalidNumFields);
            }
            let left =
                FieldElement::from_slice_be(values[0]).map_err(|_| HasherError::IntegerOverflow)?;
            let right =
                FieldElement::from_slice_be(values[1]).map_err(|_| HasherError::IntegerOverflow)?;
            Ok(horizen::compress(left, right).to_bytes_be())
        }
        fn zero_bytes() -> ZeroBytes {
            ZEROS
        }
        fn zero_indexed_leaf() -> Hash {
            panic!("indexed trees are outside this benchmark")
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn roots_are_incompatible_with_existing_circuit() {
            let fields = [&[0u8; 32][..], &[0u8; 32][..]];
            assert_ne!(
                Poseidon2::hashv(&fields).unwrap(),
                light_hasher::Poseidon::hashv(&fields).unwrap()
            );
            assert_ne!(ZEROS[26], light_hasher::Poseidon::zero_bytes()[26]);
            for level in 1..ZEROS.len() {
                assert_eq!(
                    ZEROS[level],
                    Poseidon2::hashv(&[&ZEROS[level - 1], &ZEROS[level - 1]]).unwrap()
                );
            }
            assert!(Poseidon2::hashv(&[&[255; 32], &[0; 32]]).is_err());
        }
    }
}
