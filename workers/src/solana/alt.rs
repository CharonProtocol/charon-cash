//! Address Lookup Table account parsing.
//!
//! The on-chain layout is a 56-byte meta header followed by raw 32-byte pubkey
//! entries (mirrors @solana/web3.js `LOOKUP_TABLE_META_SIZE = 56`).

use super::pubkey::Pubkey;

pub const ALT_META_SIZE: usize = 56;

pub fn parse_alt_addresses(data: &[u8]) -> Result<Vec<Pubkey>, String> {
    if data.len() < ALT_META_SIZE {
        return Err(format!("ALT account too small: {} bytes", data.len()));
    }
    let rest = &data[ALT_META_SIZE..];
    if rest.len() % 32 != 0 {
        return Err("ALT account length not aligned to 32 bytes".into());
    }
    Ok(rest.chunks_exact(32).map(|c| Pubkey(c.try_into().unwrap())).collect())
}
