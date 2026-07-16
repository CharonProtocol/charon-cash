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

    /// The tree's current root.
    ///
    /// There is no dedicated `root` field — the newest root is simply the most recently
    /// written slot of the circular `root_history`.
    pub fn current_root(&self) -> [u8; 32] {
        self.root_history[self.root_index as usize]
    }
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
    /// The only account fees may flow to. Enforced on-chain whenever a transact pays a fee, so a
    /// user cannot name themselves as fee recipient and withdraw for free. Upstream left this
    /// unchecked (its `InvalidFeeRecipient`/`RecipientMismatch` errors were dead code).
    pub fee_recipient: [u8; 32],
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
