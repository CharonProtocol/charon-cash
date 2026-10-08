//! Transaction wire encoding.
//!
//! Solana serializes legacy and versioned transactions with bincode, configured for
//! fixed-width integers and no size limit. Both are behavioural, not defaults, so
//! they live in one place rather than being restated at each call site.

use serde::{Deserialize, Serialize};

use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};

pub fn serialize<T: Serialize>(value: &T) -> RelayerResult<Vec<u8>> {
    bincode::serialize(value)
        .map_err(|e| RelayerError::internal(format!("cannot serialize transaction: {e}")))
}

pub fn deserialize<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> RelayerResult<T> {
    bincode::deserialize(bytes).map_err(|e| {
        RelayerError::new(
            ErrorCode::InvalidTransaction,
            format!("not a serialized Solana transaction: {e}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_sdk::hash::Hash;
    use solana_sdk::instruction::{AccountMeta, Instruction};
    use solana_sdk::signature::Keypair;
    use solana_sdk::signer::Signer;
    use solana_sdk::transaction::{Transaction, VersionedTransaction};

    #[test]
    fn versioned_transactions_round_trip() {
        let payer = Keypair::new();
        let ix = Instruction {
            program_id: crate::relayer::chain::SYSTEM_PROGRAM_ID,
            accounts: vec![AccountMeta::new(payer.pubkey(), true)],
            data: vec![2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        };
        let tx: VersionedTransaction =
            Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], Hash::default())
                .into();

        let bytes = serialize(&tx).unwrap();
        let decoded: VersionedTransaction = deserialize(&bytes).unwrap();
        assert_eq!(decoded.signatures, tx.signatures);
    }

    #[test]
    fn garbage_is_rejected_as_a_client_error() {
        let err = deserialize::<VersionedTransaction>(&[0xff, 0xff, 0xff]).unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidTransaction));
    }
}
