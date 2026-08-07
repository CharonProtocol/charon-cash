//! Shared indexer data types.

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
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
    pub ext_amount: i64,
    pub fee: u64,
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct IndexedUtxo {
    pub tree_key: String,
    pub leaf_index: u32,
    pub commitment: [u8; 32],
    pub encrypted_output: Vec<u8>,
    pub signature: String,
    pub slot: u64,
    pub ext_amount: i64,
    pub fee: u64,
}

#[derive(Debug, Clone)]
pub struct IndexedNullifier {
    pub tree_key: String,
    pub nullifier: [u8; 32],
    pub signature: String,
    pub slot: u64,
}

#[derive(Debug, Clone)]
pub struct IndexedTransact {
    pub signature: String,
    pub slot: u64,
    pub tree_key: String,
    pub decoded: DecodedTransact,
    pub utxos: Vec<IndexedUtxo>,
    pub nullifiers: Vec<IndexedNullifier>,
}
