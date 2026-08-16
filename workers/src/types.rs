pub const SOL_TREE_KEY: &str = "sol";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransactKind {
    Sol,
    Spl,
}

#[derive(Debug, Clone)]
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
