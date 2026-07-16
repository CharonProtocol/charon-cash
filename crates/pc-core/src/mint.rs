//! Mapping a mint to the field element the circuit uses as `mintAddress`.
//!
//! This is deliberately not the mint's pubkey bytes, and the SOL case is a genuine trap:
//!
//! * **SOL**: the field element is the base58 *string* `11111111111111111111111111111112`
//!   reinterpreted as a **decimal** integer (~1.1e31). The upstream `getMintAddressField` returns
//!   the string unchanged for SOL, and snarkjs then parses it as base-10. It is *not* derived from
//!   the 32 pubkey bytes.
//! * **SPL**: `BigUint::from_bytes_be(&mint[0..31])` — the first 31 bytes (248 bits), so it always
//!   fits in the field. The final byte is dropped; upstream notes this cannot collide across the
//!   handful of supported mints.
//!
//! Note this field is what the *circuit's* commitment binds. The `extDataHash` separately binds
//! the full 32-byte mint pubkey — see [`crate::ext_data`].

use crate::field::fr_from_decimal;
use ark_bn254::Fr;
use num_bigint::BigUint;

/// The 32-byte on-chain SOL sentinel mint (`SOL_ADDRESS` in the program).
pub const SOL_MINT: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
];

/// The base58 string of the SOL sentinel, reused as a decimal integer — the SOL `mintAddress`
/// field element. Kept as the literal the TypeScript uses so the provenance is obvious.
pub const SOL_MINT_FIELD_DEC: &str = "11111111111111111111111111111112";

/// The circuit's `mintAddress` field element for a given 32-byte mint.
pub fn mint_address_field(mint: &[u8; 32]) -> Fr {
    if mint == &SOL_MINT {
        fr_from_decimal(SOL_MINT_FIELD_DEC)
    } else {
        // First 31 big-endian bytes → always < field modulus.
        Fr::from(BigUint::from_bytes_be(&mint[0..31]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::fr_to_be32;

    #[test]
    fn sol_field_is_the_decimal_not_the_bytes() {
        let field = mint_address_field(&SOL_MINT);
        // If someone "fixes" this to use the pubkey bytes, the value changes and every SOL
        // commitment stops matching the chain. Pin it.
        assert_eq!(field, fr_from_decimal(SOL_MINT_FIELD_DEC));
        assert_ne!(fr_to_be32(&field), SOL_MINT);
    }

    #[test]
    fn spl_field_uses_first_31_bytes() {
        // USDC mint bytes end in a distinctive tail; only the first 31 matter.
        let mut mint = [7u8; 32];
        let a = mint_address_field(&mint);
        mint[31] = 200; // change only the dropped byte
        let b = mint_address_field(&mint);
        assert_eq!(a, b, "byte 31 must not affect the field");
        mint[0] = 8; // change a kept byte
        assert_ne!(a, mint_address_field(&mint));
    }
}
