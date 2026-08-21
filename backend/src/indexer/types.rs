//! Shared indexer data types.

use solana_sdk::pubkey::Pubkey;

/// Tree key for native SOL (matches privacy-cash-sdk convention).
pub const SOL_TREE_KEY: &str = "sol";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactKind {
    Sol,
    Spl,
}

/// A decoded `Transact` / `TransactSpl` program event, mirrored 1:1 from the
/// on-chain instruction payload's byte layout.
///
/// `root`, `public_amount`, and `ext_data_hash` are parsed to keep this struct
/// an exact mirror of the wire format, but are not persisted or verified today.
/// They are retained so the indexer can re-verify Groth16 proofs server-side if
/// that capability is added later (without having to re-derive the layout).
#[derive(Debug, Clone)]
#[allow(dead_code)] // parsed-but-currently-unused: root / public_amount / ext_data_hash
pub struct DecodedTransact {
    pub kind: TransactKind,
    pub output_commitments: [[u8; 32]; 2],
    pub encrypted_note1: EncryptedNote,
    pub encrypted_note2: EncryptedNote,
}

/// This is added as per the new note sharing architecture
///     ephemeral_pubkey : note's randomly generated pubkey used for encryption and decryption
///     cipher_text : nonce + authTag  + encrypted_note
/// ```no_run
/// encrypted_output = ephemeral_pubkey (32 bytes)
/// + nonce (12 bytes, for AES-GCM)
/// + authTag (16 bytes)
/// + ciphertext (variable length)
/// ```
#[derive(Debug, Clone)]
pub struct EncryptedNote {
    pub ephemeral_pubkey: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct IndexedTransact {
    pub curr_index: u32,
    pub signature: String,
    pub slot: u64,
    pub tree_key: String,
    pub decoded: DecodedTransact,
}
