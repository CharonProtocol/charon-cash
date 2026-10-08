//! Incremental Merkle mirror backed by D1.
//!
//! Unlike the VM backend (which replays the whole tree in memory), the worker
//! maintains the tree incrementally: `tree_levels` stores one blob of 32-byte
//! nodes per level (0..=26) and `trees` stores the 100-slot root ring. Reads
//! (state / proof / known-root) need zero hashing; each appended leaf costs one
//! 26-hash walk (~2ms wasm), which keeps requests inside the Workers free-tier
//! CPU budget.

use std::sync::OnceLock;

use light_hasher::{Hasher, Poseidon};
use serde::Serialize;

use crate::accounts::MERKLE_TREE_HEIGHT;
use crate::error::{AppError, AppResult};
use crate::store::{Store, TreeRow};

pub const ROOT_HISTORY_SIZE: usize = 100;

#[derive(Clone, Serialize)]
pub struct TreeState {
    pub tree_key: String,
    pub next_leaf_index: u32,
    pub current_root: String,
    pub known_roots: Vec<String>,
    pub leaf_count: i64,
}

#[derive(Clone, Serialize)]
pub struct MerklePath {
    pub root: String,
    pub next_leaf_index: u32,
    pub path_elements: [[u8; 32]; MERKLE_TREE_HEIGHT],
    pub path_indices: [u8; MERKLE_TREE_HEIGHT],
}

pub fn zero_bytes() -> &'static Vec<[u8; 32]> {
    static Z: OnceLock<Vec<[u8; 32]>> = OnceLock::new();
    Z.get_or_init(|| {
        let zb = Poseidon::zero_bytes();
        (0..=MERKLE_TREE_HEIGHT).map(|i| zb[i]).collect()
    })
}

#[derive(Clone)]
pub struct TreeData {
    pub tree_key: String,
    pub next_index: u32,
    pub root_index: usize,
    pub root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    /// levels[i] = node hashes at level i (index 0 = leaves, 26 = root).
    pub levels: Vec<Vec<[u8; 32]>>,
}

fn init_history_hex() -> String {
    let mut hist = [[0u8; 32]; ROOT_HISTORY_SIZE];
    hist[0] = zero_bytes()[MERKLE_TREE_HEIGHT];
    let mut blob = Vec::with_capacity(ROOT_HISTORY_SIZE * 32);
    for h in &hist {
        blob.extend_from_slice(h);
    }
    hex::encode(blob)
}

pub async fn load_tree(store: &Store, tree_key: &str) -> Result<TreeData, String> {
    let row: Option<TreeRow> = store.tree_row(tree_key).await?;
    let row = match row {
        Some(r) => r,
        None => {
            store
                .run_one(
                    "INSERT INTO trees (tree_key, next_index, root_index, root_history_hex) \
                     VALUES ($1, 0, 0, $2) ON CONFLICT (tree_key) DO NOTHING",
                    vec![
                        crate::store::s(tree_key),
                        crate::store::s(init_history_hex()),
                    ],
                )
                .await
                .map_err(|e| format!("init tree: {e}"))?;
            store.tree_row(tree_key).await?.ok_or("tree row missing after init")?
        }
    };

    let mut history = [[0u8; 32]; ROOT_HISTORY_SIZE];
    let blob = hex::decode(&row.root_history_hex).map_err(|e| format!("history hex: {e}"))?;
    for (i, h) in history.iter_mut().enumerate() {
        *h = blob
            .get(i * 32..i * 32 + 32)
            .and_then(|s| s.try_into().ok())
            .ok_or("history blob too short")?;
    }

    let mut levels = vec![Vec::new(); MERKLE_TREE_HEIGHT + 1];
    for lr in store.level_rows(tree_key).await? {
        let blob = hex::decode(&lr.nodes_hex).map_err(|e| format!("level hex: {e}"))?;
        if blob.len() % 32 != 0 {
            return Err("level blob misaligned".into());
        }
        let nodes: Vec<[u8; 32]> = blob.chunks_exact(32).map(|c| c.try_into().unwrap()).collect();
        let lvl = lr.level as usize;
        if lvl <= MERKLE_TREE_HEIGHT {
            levels[lvl] = nodes;
        }
    }

    Ok(TreeData {
        tree_key: tree_key.to_string(),
        next_index: row.next_index as u32,
        root_index: row.root_index as usize,
        root_history: history,
        levels,
    })
}

/// Append leaves (in order) to the in-memory tree state. Mirrors the on-chain
/// append_many exactly: one level-walk per leaf, but only the final root
/// enters the history ring — one ring entry per transact, so the mirror's
/// 100-slot window covers the same txs the program's window covers.
pub fn append_leaves(data: &mut TreeData, leaves: &[[u8; 32]]) -> Result<(), String> {
    let zb = zero_bytes();
    let mut final_root = None;
    for leaf in leaves {
        let mut cur = *leaf;
        let mut pos = data.next_index as usize;
        for i in 0..=MERKLE_TREE_HEIGHT {
            let lvl = &mut data.levels[i];
            if lvl.len() == pos {
                lvl.push(cur);
            } else if let Some(slot) = lvl.get_mut(pos) {
                *slot = cur;
            } else {
                return Err(format!("level {i} missing position {pos}"));
            }
            if i < MERKLE_TREE_HEIGHT {
                let sib_pos = pos ^ 1;
                let sib = data.levels[i].get(sib_pos).copied().unwrap_or(zb[i]);
                let (left, right) = if pos % 2 == 0 { (cur, sib) } else { (sib, cur) };
                cur = Poseidon::hashv(&[&left, &right]).map_err(|e| e.to_string())?;
                pos >>= 1;
            }
        }
        data.next_index += 1;
        final_root = Some(cur);
    }
    if let Some(root) = final_root {
        let new_root_index = (data.root_index + 1) % ROOT_HISTORY_SIZE;
        data.root_index = new_root_index;
        data.root_history[new_root_index] = root;
    }
    Ok(())
}

pub fn trees_upsert_values(data: &TreeData) -> (i64, i64, String) {
    let mut blob = Vec::with_capacity(ROOT_HISTORY_SIZE * 32);
    for h in &data.root_history {
        blob.extend_from_slice(h);
    }
    (
        data.next_index as i64,
        data.root_index as i64,
        hex::encode(blob),
    )
}

pub fn level_row(data: &TreeData, level: usize) -> String {
    let mut blob = Vec::with_capacity(data.levels[level].len() * 32);
    for n in &data.levels[level] {
        blob.extend_from_slice(n);
    }
    hex::encode(blob)
}

pub async fn state(store: &Store, tree_key: &str) -> AppResult<TreeState> {
    let data = load_tree(store, tree_key)
        .await
        .map_err(|e| AppError::internal(format!("load tree {tree_key}: {e}")))?;
    let current_root = data.root_history[data.root_index];
    let known_roots = data
        .root_history
        .iter()
        .filter(|r| **r != [0u8; 32])
        .map(|r| hex::encode_upper(r))
        .collect::<Vec<_>>();
    let leaf_count = store
        .leaf_count(tree_key)
        .await
        .map_err(|e| AppError::internal(e))?;
    Ok(TreeState {
        tree_key: tree_key.to_string(),
        next_leaf_index: data.next_index,
        current_root: hex::encode_upper(current_root),
        known_roots,
        leaf_count,
    })
}

/// Fold the sibling path of `leaf_index` up to the root, hashing exactly like
/// append_leaves. Used to detect torn reads: the sync writer updates the meta
/// row and the level rows in separate D1 queries, so a proof request racing a
/// sync can pair levels from one tree generation with a root from another —
/// the circuit rejects that pairing as ForceEqual.
fn fold_path_root(data: &TreeData, leaf_index: u32) -> Result<[u8; 32], String> {
    let zb = zero_bytes();
    let mut cur = *data
        .levels
        .first()
        .and_then(|l| l.get(leaf_index as usize))
        .ok_or_else(|| format!("leaf {leaf_index} missing from mirror"))?;
    let mut pos = leaf_index as usize;
    for i in 0..MERKLE_TREE_HEIGHT {
        let sib = data.levels[i].get((pos ^ 1) as usize).copied().unwrap_or(zb[i]);
        let (left, right) = if pos % 2 == 0 { (cur, sib) } else { (sib, cur) };
        cur = Poseidon::hashv(&[&left, &right]).map_err(|e| e.to_string())?;
        pos >>= 1;
    }
    Ok(cur)
}

/// Classify why a leaf's path can't be served from this TreeData read.
#[derive(Debug)]
enum PathError {
    /// Mirror hasn't indexed this leaf yet (sync cursor behind the chain).
    OutOfRange,
    /// Leaf is in range but the fold disagrees with the current root — the
    /// read straddled a concurrent sync write (torn).
    Torn,
}

fn path_from_data(data: &TreeData, leaf_index: u32) -> Result<MerklePath, PathError> {
    if leaf_index >= data.next_index {
        return Err(PathError::OutOfRange);
    }
    let current_root = data.root_history[data.root_index];
    if fold_path_root(data, leaf_index) != Ok(current_root) {
        return Err(PathError::Torn);
    }
    let zb = zero_bytes();
    let mut path = [[0u8; 32]; MERKLE_TREE_HEIGHT];
    for i in 0..MERKLE_TREE_HEIGHT {
        let sibling = ((leaf_index >> i) ^ 1) as usize;
        path[i] = data.levels[i].get(sibling).copied().unwrap_or(zb[i]);
    }
    let mut indices = [0u8; MERKLE_TREE_HEIGHT];
    for i in 0..MERKLE_TREE_HEIGHT {
        indices[i] = ((leaf_index >> i) & 1) as u8;
    }
    Ok(MerklePath {
        root: hex::encode_upper(current_root),
        next_leaf_index: data.next_index,
        path_elements: path,
        path_indices: indices,
    })
}

pub async fn proof(store: &Store, tree_key: &str, leaf_index: u32) -> AppResult<MerklePath> {
    // Serve only self-consistent snapshots: verify the path folds to the
    // current root before returning it, retrying while a concurrent sync write
    // leaves the mirror torn. A full backfill pass takes ~2-3s (6 getTransactions
    // + write waves), so the patience window must outlast one — 8 rounds of
    // 150ms exhausted mid-walk and failed real rows (10:22Z run, "mirror
    // stayed inconsistent"). 20 rounds ≈ 3s covers it.
    for round in 0..20 {
        let data = load_tree(store, tree_key)
            .await
            .map_err(|e| AppError::internal(format!("load tree {tree_key}: {e}")))?;
        match path_from_data(&data, leaf_index) {
            Ok(p) => return Ok(p),
            Err(PathError::OutOfRange) => {
                if round + 1 == 20 {
                    return Err(AppError::not_found(
                        "LEAF_NOT_FOUND",
                        format!(
                            "leaf_index {leaf_index} out of range (next={})",
                            data.next_index
                        ),
                    ));
                }
            }
            Err(PathError::Torn) => {}
        }
        crate::rpc::sleep_ms(150).await;
    }
    Err(AppError::internal(format!(
        "proof {leaf_index}: mirror stayed inconsistent after retries"
    )))
}

#[derive(Serialize)]
pub struct MerkleSnapshot {
    pub tree_key: String,
    /// Current root (hex upper). Every served proof folds to this root.
    pub current_root: String,
    pub next_leaf_index: u32,
    /// Paths for the requested indexes that this read could serve.
    pub proofs: Vec<MerklePath>,
    /// Requested indexes the mirror hasn't indexed yet — the client kicks the
    /// indexer instead of treating them as proof-of-churn.
    pub missing: Vec<u32>,
}

/// Root + N input paths from ONE mirror read. The engine's convergence loop
/// used to fetch each input's proof separately; two requests straddling a
/// sync commit disagreed on the root and burned the whole 6s retry budget —
/// the 15:05Z run lost 28 rows × 3 attempts to exactly that ("merkle proofs
/// did not converge on one root") while sync wave trains rolled. One read
/// makes the disagreement structurally impossible.
pub async fn snapshot(
    store: &Store,
    tree_key: &str,
    indexes: &[u32],
) -> AppResult<MerkleSnapshot> {
    let mut missing: Vec<u32> = Vec::new();
    let mut proofs: Vec<MerklePath> = Vec::new();
    let mut last: Option<TreeData> = None;
    for round in 0..20 {
        let data = load_tree(store, tree_key)
            .await
            .map_err(|e| AppError::internal(format!("load tree {tree_key}: {e}")))?;
        let mut torn = false;
        let mut miss = Vec::new();
        let mut paths = Vec::with_capacity(indexes.len());
        for &idx in indexes {
            match path_from_data(&data, idx) {
                Ok(p) => paths.push(p),
                Err(PathError::OutOfRange) => miss.push(idx),
                Err(PathError::Torn) => torn = true,
            }
        }
        if torn {
            crate::rpc::sleep_ms(150).await;
            continue;
        }
        // In-range + consistent. Give a lagging cursor ~1.5s to catch an
        // in-flight sync before answering with `missing`; the client kicks
        // the indexer from there.
        if !miss.is_empty() && round < 6 {
            crate::rpc::sleep_ms(150).await;
            continue;
        }
        missing = miss;
        proofs = paths;
        last = Some(data);
        break;
    }
    let data = last.ok_or_else(|| {
        AppError::internal(format!("snapshot {tree_key}: mirror stayed inconsistent after retries"))
    })?;
    Ok(MerkleSnapshot {
        tree_key: tree_key.to_string(),
        current_root: hex::encode_upper(data.root_history[data.root_index]),
        next_leaf_index: data.next_index,
        proofs,
        missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_tree() -> TreeData {
        let mut history = [[0u8; 32]; ROOT_HISTORY_SIZE];
        history[0] = zero_bytes()[MERKLE_TREE_HEIGHT];
        TreeData {
            tree_key: "test".into(),
            next_index: 0,
            root_index: 0,
            root_history: history,
            levels: vec![Vec::new(); MERKLE_TREE_HEIGHT + 1],
        }
    }

    fn leaf(seed: u8) -> [u8; 32] {
        let mut l = [0u8; 32];
        l[0] = seed;
        l
    }

    #[test]
    fn pair_append_writes_one_root() {
        let mut batched = fresh_tree();
        append_leaves(&mut batched, &[leaf(1), leaf(2)]).unwrap();
        assert_eq!(batched.next_index, 2);
        // Exactly one new ring slot; slot 0 still holds the init zero-root.
        assert_eq!(batched.root_index, 1);
        assert_eq!(batched.root_history[0], zero_bytes()[MERKLE_TREE_HEIGHT]);

        // The single ringed root equals the sequential per-leaf append's last
        // root, and the level tree is byte-identical.
        let mut seq = fresh_tree();
        append_leaves(&mut seq, &[leaf(1)]).unwrap();
        append_leaves(&mut seq, &[leaf(2)]).unwrap();
        assert_eq!(batched.root_history[1], seq.root_history[seq.root_index]);
        assert_eq!(batched.levels, seq.levels);
    }

    #[test]
    fn pair_append_at_odd_index_matches_sequential() {
        let mut t = fresh_tree();
        // Three single-leaf appends (deposits) leave the tree at odd indexes;
        // the pair then starts at position 3 (a right child at level 0).
        for s in 1..=3 {
            append_leaves(&mut t, &[leaf(s)]).unwrap();
        }
        assert_eq!(t.next_index, 3);
        assert_eq!(t.root_index, 3);
        let ring_after_singles = t.root_history;

        append_leaves(&mut t, &[leaf(4), leaf(5)]).unwrap();
        assert_eq!(t.next_index, 5);
        // The pair advanced the ring by exactly one slot, leaving the
        // singles' entries untouched.
        assert_eq!(t.root_index, 4);
        assert_eq!(t.root_history[3], ring_after_singles[3]);

        let mut seq = fresh_tree();
        for s in 1..=5 {
            append_leaves(&mut seq, &[leaf(s)]).unwrap();
        }
        assert_eq!(t.root_history[4], seq.root_history[5]);
        assert_eq!(t.levels, seq.levels);
    }

    #[test]
    fn empty_append_is_a_noop() {
        let mut t = fresh_tree();
        append_leaves(&mut t, &[]).unwrap();
        assert_eq!(t.next_index, 0);
        assert_eq!(t.root_index, 0);
        assert_eq!(t.root_history[0], zero_bytes()[MERKLE_TREE_HEIGHT]);
    }

    #[test]
    fn path_from_data_classifies_range_and_folds_clean() {
        let mut t = fresh_tree();
        for s in 1..=5 {
            append_leaves(&mut t, &[leaf(s)]).unwrap();
        }
        // In-range leaves pass the torn-read guard (the fold inside
        // path_from_data must equal the current root before it returns Ok).
        for idx in 0..5u32 {
            let p = path_from_data(&t, idx).unwrap();
            assert_eq!(p.root, hex::encode_upper(t.root_history[t.root_index]));
            assert_eq!(p.next_leaf_index, 5);
        }
        // Past the cursor → OutOfRange, the snapshot's "missing" signal.
        assert!(matches!(path_from_data(&t, 5), Err(PathError::OutOfRange)));
        // A half-written tree (leaf present, parents stale) is Torn: drop
        // level 1's nodes so the fold diverges from the ring root.
        let mut torn = t.clone();
        torn.levels[1] = Vec::new();
        assert!(matches!(path_from_data(&torn, 2), Err(PathError::Torn)));
    }
}
