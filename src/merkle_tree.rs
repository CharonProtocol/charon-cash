use light_hasher::Hasher;
use pinocchio::{error::ProgramError, ProgramResult};

use crate::{
    constants::{MERKLE_TREE_HEIGHT, ROOT_HISTORY_SIZE},
    error::PrivacyCashError,
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

    /// Appends a single leaf and records the resulting root.
    ///
    /// No instruction calls this: `transact` and `transact_spl` both insert
    /// their two output commitments through [`MerkleTree::append_pair`], which
    /// costs half the Poseidon syscalls. It is retained as the reference
    /// implementation that `append_pair` is tested for equivalence against.
    ///
    /// Do not reintroduce it on an instruction path. It advances `next_index`
    /// by one, and `append_pair` is only correct because `next_index` is
    /// always even; a single append would leave the tree in a state that
    /// `append_pair` rejects outright. That parity is the `tree_index_even`
    /// invariant in `privacy_cash.qedspec`, machine-checked by the generated
    /// proptest and Crucible harnesses.
    #[deprecated(
        since = "0.1.0",
        note = "single-leaf append is off the instruction path; use                 MerkleTree::append_pair. Kept only as the reference                 implementation for the equivalence test. Calling this from an                 instruction advances next_index by one and breaks the                 even-parity precondition append_pair depends on."
    )]
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

    /// Appends two leaves as a sibling pair in a single leaf-to-root walk.
    ///
    /// `transact` and `transact_spl` always insert exactly two commitments and
    /// both tree initializers start `next_index` at zero, so the two leaves
    /// always land at indices `2k` and `2k + 1`. Above level 0 those indices
    /// are equal — `2k >> l == (2k + 1) >> l` for every `l >= 1` — so two
    /// sequential `append` calls take the same branch at every level, and the
    /// second call overwrites every `subtrees` slot the first one wrote
    /// without ever reading one of them. Hashing the pair once at level 0 and
    /// walking up once therefore leaves byte-identical `subtrees`,
    /// `next_index` and root for half the Poseidon syscalls.
    ///
    /// The one observable difference is `root_history`: this writes a single
    /// entry — the root of the tree containing both leaves — instead of two,
    /// dropping the intermediate root that contained only `first_leaf`. That
    /// root has no legitimate consumer, since the two commitments are only
    /// ever published together in one transaction.
    ///
    /// The even-`next_index` precondition is enforced rather than assumed:
    /// batching a pair that is not sibling-aligned would silently corrupt the
    /// tree, so it must fail loudly instead.
    pub fn append_pair<H: Hasher>(
        first_leaf: [u8; 32],
        second_leaf: [u8; 32],
        tree_account: &mut MerkleTreeAccount,
    ) -> ProgramResult {
        let height = MERKLE_TREE_HEIGHT as usize;
        let root_history_size = ROOT_HISTORY_SIZE as usize;

        let max_capacity = 1u32
            .checked_shl(height as u32)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        let next_index = tree_account.next_index;

        // An odd `next_index` means the tree holds a state this program can
        // never produce, so the account itself is invalid.
        if next_index % 2 != 0 {
            return Err(PrivacyCashError::InvalidMerkleTreeAccount.into());
        }

        let index_after_append = next_index
            .checked_add(2)
            .ok_or(ProgramError::ArithmeticOverflow)?;

        if index_after_append > max_capacity {
            return Err(ProgramError::ArithmeticOverflow);
        }

        // Hoisted: `zero_bytes()` returns a 1 KB array by value, and the loop
        // below only ever reads one entry of it per level.
        let zero_bytes = H::zero_bytes();

        // Level 0 is the whole saving. The two leaves are each other's
        // siblings, so they hash together directly, and the left one is the
        // filled subtree that a later insert at this level would read.
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

#[cfg(test)]
#[allow(deprecated)] // the whole point of these tests is to compare against `append`
mod tests {
    use super::*;
    use light_hasher::Poseidon;

    /// Leaves must be canonical BN254 field elements; Poseidon rejects
    /// anything at or above the modulus. Small big-endian values are safe.
    fn leaf(n: u64) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        bytes[24..].copy_from_slice(&n.to_be_bytes());
        bytes
    }

    fn fresh_tree() -> MerkleTreeAccount {
        let mut tree = MerkleTreeAccount {
            max_deposit_amount: 0,
            next_index: 0,
            root_index: 0,
            bump: 0,
            _padding: [0; 2],
            subtrees: [[0u8; 32]; MERKLE_TREE_HEIGHT as usize],
            root_history: [[0u8; 32]; ROOT_HISTORY_SIZE as usize],
            authority: [0u8; 32],
        };
        MerkleTree::intialize::<Poseidon>(&mut tree).unwrap();
        tree
    }

    fn current_root(tree: &MerkleTreeAccount) -> [u8; 32] {
        tree.root_history[tree.root_index as usize]
    }

    #[test]
    fn append_pair_leaves_the_same_tree_as_two_sequential_appends() {
        let (c0, c1) = (leaf(7), leaf(11));

        let mut sequential = fresh_tree();
        MerkleTree::append::<Poseidon>(c0, &mut sequential).unwrap();
        MerkleTree::append::<Poseidon>(c1, &mut sequential).unwrap();

        let mut batched = fresh_tree();
        MerkleTree::append_pair::<Poseidon>(c0, c1, &mut batched).unwrap();

        assert_eq!(batched.subtrees, sequential.subtrees, "subtrees diverged");
        assert_eq!(batched.next_index, sequential.next_index, "next_index diverged");
        assert_eq!(
            current_root(&batched),
            current_root(&sequential),
            "final root diverged"
        );
    }

    #[test]
    fn append_pair_stays_equivalent_across_many_pairs() {
        let mut sequential = fresh_tree();
        let mut batched = fresh_tree();

        // Eight pairs exercise both parities at levels 0..=3, which is where
        // every distinct left/right branch combination first appears.
        for i in 0..8u64 {
            let (c0, c1) = (leaf(2 * i + 1), leaf(2 * i + 2));

            MerkleTree::append::<Poseidon>(c0, &mut sequential).unwrap();
            MerkleTree::append::<Poseidon>(c1, &mut sequential).unwrap();
            MerkleTree::append_pair::<Poseidon>(c0, c1, &mut batched).unwrap();

            assert_eq!(batched.subtrees, sequential.subtrees, "subtrees diverged at pair {i}");
            assert_eq!(batched.next_index, sequential.next_index, "next_index diverged at pair {i}");
            assert_eq!(
                current_root(&batched),
                current_root(&sequential),
                "root diverged at pair {i}"
            );
        }
    }

    #[test]
    fn append_pair_writes_exactly_one_root_history_entry() {
        let mut tree = fresh_tree();
        MerkleTree::append_pair::<Poseidon>(leaf(7), leaf(11), &mut tree).unwrap();

        assert_eq!(tree.root_index, 1);
        // The pre-existing genesis root must survive at slot 0.
        assert_eq!(tree.root_history[0], Poseidon::zero_bytes()[MERKLE_TREE_HEIGHT as usize]);
    }

    #[test]
    fn append_pair_rejects_an_odd_next_index() {
        let mut tree = fresh_tree();
        tree.next_index = 1;

        assert!(
            MerkleTree::append_pair::<Poseidon>(leaf(7), leaf(11), &mut tree).is_err(),
            "an odd next_index must not be batched: the pair would not be siblings"
        );
    }

    #[test]
    fn append_pair_rejects_a_full_tree() {
        let capacity = 1u32 << MERKLE_TREE_HEIGHT;

        let mut tree = fresh_tree();
        tree.next_index = capacity;
        assert!(MerkleTree::append_pair::<Poseidon>(leaf(7), leaf(11), &mut tree).is_err());

        // The last legal pair fills the tree exactly.
        let mut tree = fresh_tree();
        tree.next_index = capacity - 2;
        MerkleTree::append_pair::<Poseidon>(leaf(7), leaf(11), &mut tree).unwrap();
        assert_eq!(tree.next_index, capacity);
    }
}
