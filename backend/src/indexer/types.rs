//! Shared indexer data types.

/// Tree key for native SOL (matches privacy-cash-sdk convention).
pub const SOL_TREE_KEY: &str = "sol";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactKind {
    Sol,
    Spl,
}

#[derive(Debug, Clone)]
pub struct DecodedTransact {
    pub kind: TransactKind,
    #[allow(dead_code)]
    pub root: [u8; 32],
    #[allow(dead_code)]
    pub public_amount: [u8; 32],
    #[allow(dead_code)]
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
