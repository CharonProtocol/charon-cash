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
        let zero_bytes = H::zero_bytes();

        for i in 0..height {
            let subtree = &mut tree_account.subtrees[i];
            let zero_byte = zero_bytes[i];

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

    /// Appends `leaves` in order. A leaf landing on an even index is paired
    /// with the next one under a single level-0 hash (hash(a, b)), skipping
    /// the walk to the root that the lone append would have done and whose
    /// every level the second append overwrites: 26 hashes per pair instead
    /// of 52. Any starting parity is handled — deposits interleave single
    /// leaves, so a transact's first index is not always even — and a lone
    /// leaf (odd index, or the tail of an odd count) hashes exactly as
    /// append() does. Only the final root enters root_history: intermediate
    /// roots of a multi-leaf transact are unobservable mid-transaction, and
    /// one root per transact instead of per leaf slows eviction of the
    /// ROOT_HISTORY_SIZE window by the batch size.
    pub fn append_many<H: Hasher>(
        leaves: &[[u8; 32]],
        tree_account: &mut MerkleTreeAccount,
    ) -> core::result::Result<(), ProgramError> {
        let height = MERKLE_TREE_HEIGHT as usize;
        let root_history_size = ROOT_HISTORY_SIZE as usize;
        let n = leaves.len();

        let max_capacity = 1u32
            .checked_shl(height as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        let new_next_index = tree_account
            .next_index
            .checked_add(n as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if new_next_index > max_capacity {
            return Err(ProgramError::ArithmeticOverflow.into());
        }

        let zero_bytes = H::zero_bytes();
        let mut index = tree_account.next_index as usize;
        let mut k = 0usize;
        let mut final_root = [0u8; 32];

        while k < n {
            // Level 0. A pair consumes leaves[k] (even index) and leaves[k + 1].
            let (mut current_level_hash, consumed) = if index % 2 == 0 && k + 1 < n {
                tree_account.subtrees[0] = leaves[k];
                (
                    H::hashv(&[&leaves[k], &leaves[k + 1]])
                        .map_err(|_| ProgramError::InvalidArgument)?,
                    2,
                )
            } else if index % 2 == 0 {
                tree_account.subtrees[0] = leaves[k];
                (
                    H::hashv(&[&leaves[k], &zero_bytes[0]])
                        .map_err(|_| ProgramError::InvalidArgument)?,
                    1,
                )
            } else {
                (
                    H::hashv(&[&tree_account.subtrees[0], &leaves[k]])
                        .map_err(|_| ProgramError::InvalidArgument)?,
                    1,
                )
            };
            k += consumed;
            index += consumed;

            let mut current_index = (index - 1) / 2;
            for i in 1..height {
                let subtree = &mut tree_account.subtrees[i];
                let zero_byte = zero_bytes[i];

                let (left, right);
                if current_index % 2 == 0 {
                    left = current_level_hash;
                    right = zero_byte;
                    *subtree = current_level_hash;
                } else {
                    left = *subtree;
                    right = current_level_hash;
                }
                current_level_hash = H::hashv(&[&left, &right])
                    .map_err(|_| ProgramError::InvalidArgument)?;
                current_index /= 2;
            }
            final_root = current_level_hash;
        }

        tree_account.next_index = new_next_index;
        let new_root_index = (tree_account.root_index as usize + 1) % root_history_size;
        tree_account.root_index = new_root_index as u8;
        tree_account.root_history[new_root_index] = final_root;

        Ok(())
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

#[cfg(test)]
mod tests {
    use super::MerkleTree;
    use crate::constants::{MERKLE_TREE_HEIGHT, ROOT_HISTORY_SIZE};
    use crate::state::MerkleTreeAccount;
    use light_hasher::{Hasher, Poseidon};

    fn leaf(i: u32) -> [u8; 32] {
        Poseidon::hashv(&[&i.to_le_bytes()]).unwrap()
    }

    fn fresh_tree(next_index: u32) -> MerkleTreeAccount {
        let mut tree = MerkleTreeAccount {
            max_deposit_amount: 0,
            next_index,
            root_index: 0,
            bump: 255,
            _padding: [0u8; 2],
            subtrees: [[0u8; 32]; MERKLE_TREE_HEIGHT as usize],
            root_history: [[0u8; 32]; ROOT_HISTORY_SIZE as usize],
            authority: [0u8; 32],
        };
        MerkleTree::intialize::<Poseidon>(&mut tree).unwrap();
        tree
    }

    /// append_many must leave the tree byte-identical to running the shipped
    /// append() once per leaf, for every starting parity (deposits interleave
    /// single leaves) and every batch size — the final root matches and the
    /// intermediate roots are the only thing deliberately not recorded.
    #[test]
    fn append_many_matches_sequential_appends() {
        for start in 0u32..4 {
            for n in 1usize..=6 {
                let leaves: Vec<[u8; 32]> = (0..n as u32).map(leaf).collect();

                let mut sequential = fresh_tree(0);
                for _ in 0..start {
                    MerkleTree::append::<Poseidon>(leaf(start), &mut sequential).unwrap();
                }
                let mut batched = fresh_tree(0);
                for _ in 0..start {
                    MerkleTree::append::<Poseidon>(leaf(start), &mut batched).unwrap();
                }

                for l in &leaves {
                    MerkleTree::append::<Poseidon>(*l, &mut sequential).unwrap();
                }
                MerkleTree::append_many::<Poseidon>(&leaves, &mut batched).unwrap();

                assert_eq!(sequential.next_index, batched.next_index);
                assert_eq!(sequential.subtrees, batched.subtrees);
                let s = sequential.root_history[sequential.root_index as usize];
                let b = batched.root_history[batched.root_index as usize];
                assert_eq!(s, b, "final root differs at start={start} n={n}");
                assert!(MerkleTree::is_known_root(&batched, b));
            }
        }
    }

    #[test]
    fn append_many_rejects_overflow() {
        let mut tree = fresh_tree(0);
        let leaves = [leaf(0); 3];
        tree.next_index = u32::MAX - 1;
        assert!(MerkleTree::append_many::<Poseidon>(&leaves, &mut tree).is_err());
    }
}
