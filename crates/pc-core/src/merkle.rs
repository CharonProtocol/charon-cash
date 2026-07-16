//! Client-side Merkle mirror.
//!
//! A sparse reconstruction of the on-chain append-only tree, rebuilt from the commitments an
//! indexer reports (in leaf-index order). It exists to answer two questions the chain can't: the
//! current root, and the sibling path for any past leaf (needed to prove a withdrawal).
//!
//! Only filled nodes are stored; empty subtrees collapse to precomputed per-level zero hashes, so
//! memory is O(leaves · depth), not O(2^depth). The hashing order (even index = left) matches the
//! program's `MerkleTree::append`, so [`MerkleTree::root`] equals the on-chain root leaf-for-leaf —
//! which is exactly what the [`pc_types::CommitmentEvent`] root lets a caller assert.

use crate::field::fr_to_be32;
use crate::hash::poseidon;
use ark_bn254::Fr;
use pc_types::seeds::MERKLE_TREE_HEIGHT;
use std::collections::HashMap;

const HEIGHT: usize = MERKLE_TREE_HEIGHT as usize;

pub struct MerkleTree {
    /// Filled nodes keyed by `(level, index)`. Level 0 is the leaves.
    nodes: HashMap<(u8, u64), Fr>,
    /// `zeros[level]` is the hash of an all-empty subtree of that height. `zeros[0]` is the field 0.
    zeros: [Fr; HEIGHT + 1],
    next_index: u64,
}

impl Default for MerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

impl MerkleTree {
    pub fn new() -> Self {
        let mut zeros = [Fr::from(0u64); HEIGHT + 1];
        for level in 1..=HEIGHT {
            zeros[level] = poseidon(&[zeros[level - 1], zeros[level - 1]]);
        }
        Self {
            nodes: HashMap::new(),
            zeros,
            next_index: 0,
        }
    }

    pub fn next_index(&self) -> u64 {
        self.next_index
    }

    fn node(&self, level: u8, index: u64) -> Fr {
        *self
            .nodes
            .get(&(level, index))
            .unwrap_or(&self.zeros[level as usize])
    }

    /// Append a commitment at the next free leaf, recomputing the path to the root.
    ///
    /// Commitments must be inserted in index order; the indexer guarantees this by keying on the
    /// event's `leaf_index`.
    pub fn append(&mut self, leaf: Fr) {
        let mut index = self.next_index;
        self.nodes.insert((0, index), leaf);
        for level in 0..HEIGHT as u8 {
            let parent = index >> 1;
            let left = self.node(level, parent * 2);
            let right = self.node(level, parent * 2 + 1);
            self.nodes.insert((level + 1, parent), poseidon(&[left, right]));
            index = parent;
        }
        self.next_index += 1;
    }

    /// Append a commitment given as big-endian bytes.
    pub fn append_be32(&mut self, leaf: &[u8; 32]) {
        self.append(crate::field::fr_from_be_bytes_mod_order(leaf));
    }

    /// The current root.
    pub fn root(&self) -> Fr {
        self.node(HEIGHT as u8, 0)
    }

    pub fn root_be32(&self) -> [u8; 32] {
        fr_to_be32(&self.root())
    }

    /// The 26 sibling elements proving membership of the leaf at `index`, bottom-up.
    ///
    /// Returns `None` if `index` has not been inserted — proving a leaf that isn't in the tree is
    /// always a mistake, so surface it rather than return a path to a zero.
    pub fn path_elements(&self, index: u64) -> Option<[Fr; HEIGHT]> {
        if index >= self.next_index {
            return None;
        }
        let mut elements = [Fr::from(0u64); HEIGHT];
        let mut idx = index;
        for level in 0..HEIGHT as u8 {
            elements[level as usize] = self.node(level, idx ^ 1);
            idx >>= 1;
        }
        Some(elements)
    }

    /// [`path_elements`](Self::path_elements) as big-endian bytes — the on-wire / on-circuit form.
    pub fn path_elements_be32(&self, index: u64) -> Option<[[u8; 32]; HEIGHT]> {
        let path = self.path_elements(index)?;
        let mut out = [[0u8; 32]; HEIGHT];
        for (slot, el) in out.iter_mut().zip(path.iter()) {
            *slot = fr_to_be32(el);
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_root_is_the_zero_subtree() {
        let tree = MerkleTree::new();
        // An empty tree's root is zeros[HEIGHT]; a freshly-built tree must agree with itself.
        assert_eq!(tree.root(), tree.zeros[HEIGHT]);
    }

    #[test]
    fn path_absent_leaf_is_none() {
        let mut tree = MerkleTree::new();
        tree.append(Fr::from(7u64));
        assert!(tree.path_elements(0).is_some());
        assert!(tree.path_elements(1).is_none());
    }

    #[test]
    fn root_changes_on_append() {
        let mut tree = MerkleTree::new();
        let r0 = tree.root();
        tree.append(Fr::from(1u64));
        let r1 = tree.root();
        tree.append(Fr::from(2u64));
        assert_ne!(r0, r1);
        assert_ne!(r1, tree.root());
    }

    // Recomputing a two-leaf root by hand and comparing to the sparse tree pins the hashing order
    // (even = left) against the on-chain `append`.
    #[test]
    fn two_leaf_root_matches_manual_hash() {
        let mut tree = MerkleTree::new();
        let a = Fr::from(11u64);
        let b = Fr::from(22u64);
        tree.append(a);
        tree.append(b);

        // Level 1 node 0 = P(a, b); every higher level pairs with the zero subtree.
        let mut h = poseidon(&[a, b]);
        for level in 1..HEIGHT {
            h = poseidon(&[h, tree.zeros[level]]);
        }
        assert_eq!(tree.root(), h);
    }
}
