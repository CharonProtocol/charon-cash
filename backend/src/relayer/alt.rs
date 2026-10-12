//! Address Lookup Table reads.
//!
//! SPL transacts cannot fit inline: a 352-byte proof plus two ciphertexts plus 16
//! accounts overflows the 1232-byte packet. The lookup table moves the static
//! accounts off the wire.

use solana_sdk::message::AddressLookupTableAccount;
use solana_sdk::pubkey::Pubkey;

use crate::relayer::rpc::RpcClient;

use crate::relayer::error::{RelayerError, RelayerResult};

/// Fixed header before the address array in a lookup table account: discriminant,
/// deactivation slot, last extended slot and index, an optional authority, padding.
const LOOKUP_TABLE_META_SIZE: usize = 56;

/// Parsed manually rather than through the interface crate so the layout the
/// relayer depends on is visible and pinned here.
pub fn parse_lookup_table(address: Pubkey, data: &[u8]) -> RelayerResult<AddressLookupTableAccount> {
    if data.len() < LOOKUP_TABLE_META_SIZE {
        return Err(RelayerError::upstream(format!(
            "lookup table {address} is {} bytes, shorter than its {LOOKUP_TABLE_META_SIZE}-byte header",
            data.len()
        )));
    }
    let body = &data[LOOKUP_TABLE_META_SIZE..];
    if body.len() % 32 != 0 {
        return Err(RelayerError::upstream(format!(
            "lookup table {address} address array is {} bytes, not a multiple of 32",
            body.len()
        )));
    }
    let addresses = body
        .chunks_exact(32)
        .map(|c| {
            let mut key = [0u8; 32];
            key.copy_from_slice(c);
            Pubkey::new_from_array(key)
        })
        .collect();

    Ok(AddressLookupTableAccount { key: address, addresses })
}

pub async fn fetch_lookup_table(
    rpc: &RpcClient,
    address: &Pubkey,
) -> RelayerResult<AddressLookupTableAccount> {
    let data = rpc
        .get_account_data(address)
        .await?
        .ok_or_else(|| RelayerError::upstream(format!("lookup table {address} does not exist")))?;
    parse_lookup_table(*address, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_start_after_the_header() {
        let key = Pubkey::new_unique();
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        let mut data = vec![0u8; LOOKUP_TABLE_META_SIZE];
        data.extend_from_slice(a.as_ref());
        data.extend_from_slice(b.as_ref());

        let table = parse_lookup_table(key, &data).unwrap();
        assert_eq!(table.key, key);
        assert_eq!(table.addresses, vec![a, b]);
    }

    #[test]
    fn a_truncated_address_is_rejected_rather_than_ignored() {
        let mut data = vec![0u8; LOOKUP_TABLE_META_SIZE + 31];
        data[0] = 1;
        assert!(parse_lookup_table(Pubkey::new_unique(), &data).is_err());
    }
}
