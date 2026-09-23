//! Root-history dedup: two leaves, one ring slot.
//!
//! These tests do not go through SVM. They pin the Merkle bookkeeping the
//! program uses, so a future instruction cannot quietly go back to recording
//! a root per leaf.

mod common;

use common::merkle_tree::MerkleTree as OffChainTree;
use light_hasher::Poseidon;
use privacy_cash::{
    constants::{MERKLE_TREE_HEIGHT, ROOT_HISTORY_SIZE},
    merkle_tree::MerkleTree,
    state::MerkleTreeAccount,
};

fn empty_account() -> MerkleTreeAccount {
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

/// Distinct field elements. Last-byte counters stay well below BN254 modulus.
fn leaf(n: u8) -> [u8; 32] {
    let mut l = [0u8; 32];
    l[31] = n;
    l
}

fn current_root(tree: &MerkleTreeAccount) -> [u8; 32] {
    tree.root_history[tree.root_index as usize]
}

#[test]
fn append_pair_matches_two_off_chain_inserts() {
    let a = leaf(1);
    let b = leaf(2);

    let mut off = OffChainTree::default();
    off.insert(a);
    off.insert(b);

    let mut on = empty_account();
    MerkleTree::append_pair::<Poseidon>(&[a, b], &mut on).unwrap();

    assert_eq!(on.next_index, 2);
    assert_eq!(current_root(&on), off.root());
}

#[test]
fn append_pair_records_one_history_slot() {
    let mut on = empty_account();
    let empty_root = current_root(&on);
    assert_eq!(on.root_index, 0);

    MerkleTree::append_pair::<Poseidon>(&[leaf(1), leaf(2)], &mut on).unwrap();

    assert_eq!(on.next_index, 2);
    assert_eq!(on.root_index, 1);
    assert!(MerkleTree::is_known_root(&on, current_root(&on)));
    assert!(MerkleTree::is_known_root(&on, empty_root));
}

#[test]
fn odd_leaf_root_is_not_in_history() {
    let a = leaf(1);
    let b = leaf(2);

    let mut mid = empty_account();
    let odd_root = MerkleTree::append_leaf::<Poseidon>(a, &mut mid).unwrap();
    assert_eq!(mid.next_index, 1);
    assert_eq!(mid.root_index, 0, "append_leaf must not rotate the ring");
    assert!(
        !MerkleTree::is_known_root(&mid, odd_root),
        "the half-updated tree is not a known root even on the account that produced it"
    );

    let mut complete = empty_account();
    MerkleTree::append_pair::<Poseidon>(&[a, b], &mut complete).unwrap();
    assert!(
        !MerkleTree::is_known_root(&complete, odd_root),
        "clients never prove against the odd-leaf tree, and it must not occupy a ring slot"
    );
    assert!(MerkleTree::is_known_root(&complete, current_root(&complete)));
}

#[test]
fn hundred_and_first_pair_evicts_the_oldest_complete_root() {
    let mut on = empty_account();
    let empty_root = current_root(&on);

    let mut first_complete = [0u8; 32];
    for i in 0..ROOT_HISTORY_SIZE as u16 {
        // Pairs 0..99. Leaf bytes stay unique and in-field.
        let lo = ((i * 2) % 250) as u8 + 1;
        let hi = lo.saturating_add(1);
        MerkleTree::append_pair::<Poseidon>(&[leaf(lo), leaf(hi)], &mut on).unwrap();
        if i == 0 {
            first_complete = current_root(&on);
        }
    }

    // 100 pairs: root_index wrapped to 0, overwriting the empty-tree slot.
    assert_eq!(on.root_index, 0);
    assert_eq!(on.next_index, (ROOT_HISTORY_SIZE as u32) * 2);
    assert!(
        !MerkleTree::is_known_root(&on, empty_root),
        "empty-tree root is the first slot evicted"
    );
    assert!(MerkleTree::is_known_root(&on, first_complete));

    MerkleTree::append_pair::<Poseidon>(&[leaf(200), leaf(201)], &mut on).unwrap();
    assert_eq!(on.root_index, 1);
    assert!(
        !MerkleTree::is_known_root(&on, first_complete),
        "the 101st pair evicts the oldest complete root"
    );
}
