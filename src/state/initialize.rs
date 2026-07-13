use crate::constants::{MERKLE_TREE_HEIGHT, ROOT_HISTORY_SIZE};
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Zeroable, Pod, Clone, Copy)]
pub struct MerkleTreeAccount {
    pub max_deposit_amount: u64,
    pub next_index: u32,
    pub root_index: u8,
    pub bump: u8,
    pub _padding: [u8; 2],
    pub subtrees: [[u8; 32]; MERKLE_TREE_HEIGHT as usize],
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE as usize],
    pub authority: [u8; 32],
}
impl MerkleTreeAccount {
    pub const LEN: usize = std::mem::size_of::<MerkleTreeAccount>();
}

#[repr(C)]
#[derive(Zeroable, Pod, Clone, Copy)]
pub struct TreeTokenAccount {
    pub authority: [u8; 32],
    pub bump: u8,
}
impl TreeTokenAccount {
    pub const LEN: usize = std::mem::size_of::<TreeTokenAccount>();
}

#[repr(C)]
#[derive(Zeroable, Pod, Clone, Copy)]
pub struct GlobalConfig {
    pub authority: [u8; 32],
    pub deposit_fee_rate: u16, // basis points (0-10000, where 10000 = 100%)
    pub withdrawal_fee_rate: u16, // basis points (0-10000, where 10000 = 100%)
    pub fee_error_margin: u16, // basis points (0-10000, where 10000 = 100%)
    pub _padding: u8,
    pub bump: u8,
}
impl GlobalConfig {
    pub const LEN: usize = std::mem::size_of::<GlobalConfig>();
}

#[repr(C)]
#[derive(Zeroable, Pod, Clone, Copy)]
pub struct NullifierAccount {
    /// This account's existence indicates that the nullifier has been used.
    /// No fields needed other than bump for PDA verification.
    pub bump: u8,
}
