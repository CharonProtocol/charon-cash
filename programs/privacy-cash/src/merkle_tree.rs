use light_hasher::Hasher;
use pinocchio::{error::ProgramError, ProgramResult};

use crate::{
    constants::{MERKLE_TREE_HEIGHT, ROOT_HISTORY_SIZE},
    error::PrivacyCashError,
    state::MerkleTreeAccount,
};

/// Sparse Poseidon Merkle tree (height 26) plus a 100-slot root-history ring.
///
/// Leaves move the frontier. A completed instruction records **one** root.
/// Every transact/swap-leg still appends two output commitments; dummy vs real
/// is irrelevant — both are leaves. The ring is snapshots of the completed tree,
/// which is what clients prove against. Recording after every leaf used to burn
/// two slots per transaction, one of them an odd-leaf root nobody reconstructs.
///
/// Upgrade: program only. Tree PDAs are not resized. Honest in-flight proofs
/// already target complete roots and stay valid until they age out. Intermediate
/// roots already in the ring remain accepted until overwritten.
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

    /// Insert one leaf into the frontier. Does not touch `root_history`.
    ///
    /// Returns the root of the tree after this leaf. Instructions must not call
    /// this twice and record both results — use [`Self::append_pair`].
    pub fn append_leaf<H: Hasher>(
        leaf: [u8; 32],
        tree_account: &mut MerkleTreeAccount,
    ) -> core::result::Result<[u8; 32], ProgramError> {
        let height = MERKLE_TREE_HEIGHT as usize;

        let max_capacity = 1u32
            .checked_shl(height as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if tree_account.next_index >= max_capacity {
            return Err(ProgramError::ArithmeticOverflow);
        }

        let mut current_index = tree_account.next_index as usize;
        let mut current_level_hash = leaf;
        // `zero_bytes()` returns a 1 KB array by value. The loop reads one entry.
        let zero_bytes = H::zero_bytes();

        for i in 0..height {
            let subtree = &mut tree_account.subtrees[i];
            let zero_byte = zero_bytes[i];

            let (left, right) = if current_index % 2 == 0 {
                *subtree = current_level_hash;
                (current_level_hash, zero_byte)
            } else {
                (*subtree, current_level_hash)
            };
            current_level_hash = H::hashv(&[&left, &right])
                .map_err(|_| ProgramError::InvalidArgument)?;
            current_index /= 2;
        }

        tree_account.next_index = tree_account
            .next_index
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        Ok(current_level_hash)
    }

    /// Rotate `root` into the history ring. Same wraparound as before.
    pub fn record_root(tree_account: &mut MerkleTreeAccount, root: [u8; 32]) {
        let root_history_size = ROOT_HISTORY_SIZE as usize;
        let new_root_index = (tree_account.root_index as usize + 1) % root_history_size;
        tree_account.root_index = new_root_index as u8;
        tree_account.root_history[new_root_index] = root;
    }

    /// Two sibling leaves, one leaf-to-root walk, one history slot.
    ///
    /// Instructions always insert exactly two commitments, and both tree
    /// initializers start `next_index` at zero, so the pair lands at `2k` and
    /// `2k + 1`. Above level 0 those indices share a path, and a second
    /// `append_leaf` would overwrite every subtree the first walk wrote.
    /// Hashing the pair at level 0 and walking once leaves the same `subtrees`,
    /// `next_index`, and root for half the Poseidon hashes.
    ///
    /// An odd `next_index` is a tree this program cannot produce. Batching a
    /// pair that is not sibling-aligned would corrupt the frontier, so it fails.
    pub fn append_pair<H: Hasher>(
        leaves: &[[u8; 32]; 2],
        tree_account: &mut MerkleTreeAccount,
    ) -> ProgramResult {
        let height = MERKLE_TREE_HEIGHT as usize;
        let root_history_size = ROOT_HISTORY_SIZE as usize;

        let max_capacity = 1u32
            .checked_shl(height as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        let next_index = tree_account.next_index;
        if next_index % 2 != 0 {
            return Err(PrivacyCashError::InvalidMerkleTreeAccount.into());
        }

        let index_after_append = next_index
            .checked_add(2)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if index_after_append > max_capacity {
            return Err(ProgramError::ArithmeticOverflow);
        }

        let zero_bytes = H::zero_bytes();
        let first_leaf = leaves[0];
        let second_leaf = leaves[1];

        tree_account.subtrees[0] = first_leaf;
        let mut current_level_hash = H::hashv(&[&first_leaf, &second_leaf])
            .map_err(|_| ProgramError::InvalidArgument)?;
        let mut current_index = (next_index >> 1) as usize;

        for i in 1..height {
            let (left, right) = if current_index % 2 == 0 {
                tree_account.subtrees[i] = current_level_hash;
                (current_level_hash, zero_bytes[i])
            } else {
                (tree_account.subtrees[i], current_level_hash)
            };
            current_level_hash =
                H::hashv(&[&left, &right]).map_err(|_| ProgramError::InvalidArgument)?;
            current_index /= 2;
        }

        tree_account.next_index = index_after_append;

        let new_root_index = (tree_account.root_index as usize + 1) % root_history_size;
        tree_account.root_index = new_root_index as u8;
        tree_account.root_history[new_root_index] = current_level_hash;

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
