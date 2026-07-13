use light_hasher::Hasher;
use pinocchio::{error::ProgramError, ProgramResult};

use crate::{
    constants::{MERKLE_TREE_HEIGHT, ROOT_HISTORY_SIZE},
    state::MerkleTreeAccount,
};

pub struct MerkleTree;

impl MerkleTree {
    pub fn intialize<H: Hasher>(tree_account: &mut MerkleTreeAccount) -> ProgramResult {
        let zero_bytes = H::zero_bytes();
        for i in 0..MERKLE_TREE_HEIGHT as usize {
            tree_account.subtrees[i] = zero_bytes[i];
        }

        tree_account.root_history[0] = zero_bytes[MERKLE_TREE_HEIGHT as usize];

        Ok(())
    }

    pub fn append<H: Hasher>(
        leaf: [u8; 32],
        tree_account: &mut MerkleTreeAccount,
    ) -> core::result::Result<[[u8; 32]; MERKLE_TREE_HEIGHT as usize], ProgramError> {
        let height = MERKLE_TREE_HEIGHT as usize;
        let root_history_size = ROOT_HISTORY_SIZE as usize;

        let max_capacity = 1u32
            .checked_shl(height as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if tree_account.next_index >= max_capacity {
            return Err(ProgramError::ArithmeticOverflow.into());
        }

        let mut current_index = tree_account.next_index as usize;
        let mut current_level_hash = leaf;
        let mut left;
        let mut right;

        let mut proof = [[0u8; 32]; MERKLE_TREE_HEIGHT as usize];

        for i in 0..height {
            let subtree = &mut tree_account.subtrees[i];
            let zero_byte = H::zero_bytes()[i];

            if current_index % 2 == 0 {
                left = current_level_hash;
                right = zero_byte;
                *subtree = current_level_hash;
                proof[i] = right;
            } else {
                left = *subtree;
                right = current_level_hash;
                proof[i] = left;
            }
            current_level_hash = H::hashv(&[&left, &right]).unwrap();
            current_index /= 2;
        }

        tree_account.next_index = tree_account
            .next_index
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)
            .unwrap();

        let new_root_index = (tree_account.root_index as usize + 1) % root_history_size;
        tree_account.root_index = new_root_index as u8;
        tree_account.root_history[new_root_index] = current_level_hash;

        Ok(proof)
    }

    pub fn is_known_root(tree_account: &MerkleTreeAccount, root: [u8; 32]) -> bool {
        if root == [0u8; 32] {
            return false;
        }

        let root_history_size = ROOT_HISTORY_SIZE as usize;
        let current_root_index = tree_account.root_index as usize;
        let mut i = current_root_index;

        loop {
            if root == tree_account.root_history[i] {
                return true;
            }

            if i == 0 {
                i = root_history_size - 1;
            } else {
                i -= 1;
            }

            if i == current_root_index {
                break;
            }
        }

        false
    }
}
