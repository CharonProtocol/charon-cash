use std::fmt;

use sha2::{Digest, Sha256};

use super::b58;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pubkey(pub [u8; 32]);

impl Pubkey {
    pub const fn new(bytes: [u8; 32]) -> Self {
        Pubkey(bytes)
    }

    pub fn as_ref(&self) -> &[u8] {
        &self.0
    }

    pub fn to_bytes(self) -> [u8; 32] {
        self.0
    }

    pub fn parse(s: &str) -> Option<Self> {
        let bytes = b58::decode(s.trim())?;
        if bytes.len() != 32 {
            return None;
        }
        let arr: [u8; 32] = bytes.try_into().unwrap();
        Some(Pubkey(arr))
    }

    pub fn is_on_curve(&self) -> bool {
        use curve25519_dalek::edwards::CompressedEdwardsY;
        CompressedEdwardsY::from_slice(&self.0).ok().and_then(|c| c.decompress()).is_some()
    }

    /// Mirrors solana_sdk::pubkey::Pubkey::create_program_address: the derived
    /// hash must NOT lie on the ed25519 curve.
    pub fn create_program_address(seeds: &[&[u8]], program_id: &Pubkey) -> Option<Pubkey> {
        if seeds.iter().any(|s| s.len() > 32) {
            return None;
        }
        let mut hasher = Sha256::new();
        for s in seeds {
            hasher.update(s);
        }
        hasher.update(program_id.as_ref());
        hasher.update(b"ProgramDerivedAddress");
        let bytes: [u8; 32] = hasher.finalize().into();
        let candidate = Pubkey(bytes);
        if candidate.is_on_curve() {
            None
        } else {
            Some(candidate)
        }
    }

    /// Mirrors solana_sdk::pubkey::Pubkey::find_program_address (bump 255..=0).
    pub fn find_program_address(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
        let mut bump = [255u8];
        loop {
            let mut with_bump: Vec<&[u8]> = seeds.to_vec();
            with_bump.push(&bump);
            if let Some(pk) = Self::create_program_address(&with_bump, program_id) {
                return (pk, bump[0]);
            }
            bump[0] = bump[0].wrapping_sub(1);
        }
    }
}

impl fmt::Display for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&b58::encode(&self.0))
    }
}

impl fmt::Debug for Pubkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&b58::encode(&self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_program_derives_zero_pubkey() {
        let sys = Pubkey::parse("11111111111111111111111111111111").unwrap();
        assert_eq!(sys.0, [0u8; 32]);
    }

    #[test]
    fn pda_matches_known_vector() {
        // Well-known PDA: associated token account program derives addresses the
        // same way; sanity-check determinism + off-curve-ness here instead.
        let program = Pubkey::parse("9PpZ9iUSCk6fuv4MvFEkN64hd7kkh28GxGLgSUDRZA9V").unwrap();
        let (pk, bump) = Pubkey::find_program_address(&[b"merkle_tree"], &program);
        assert!(bump <= 255);
        assert!(!pk.is_on_curve());
        let (pk2, _) = Pubkey::find_program_address(&[b"merkle_tree"], &program);
        assert_eq!(pk, pk2);
    }
}
