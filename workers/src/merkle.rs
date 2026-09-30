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
                .bound(
                    "INSERT INTO trees (tree_key, next_index, root_index, root_history_hex) \
                     VALUES (?1, 0, 0, ?2) ON CONFLICT (tree_key) DO NOTHING",
                    vec![crate::store::s(tree_key), crate::store::s(init_history_hex())],
                )?
                .run()
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
/// incremental append exactly: sibling defaults to the level's zero hash.
pub fn append_leaves(data: &mut TreeData, leaves: &[[u8; 32]]) -> Result<(), String> {
    let zb = zero_bytes();
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
        let new_root_index = (data.root_index + 1) % ROOT_HISTORY_SIZE;
        data.root_index = new_root_index;
        data.root_history[new_root_index] = cur;
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

pub async fn proof(store: &Store, tree_key: &str, leaf_index: u32) -> AppResult<MerklePath> {
    // Serve only self-consistent snapshots: verify the path folds to the
    // current root before returning it, retrying briefly while a concurrent
    // sync write leaves the mirror torn.
    for round in 0..8 {
        let data = load_tree(store, tree_key)
            .await
            .map_err(|e| AppError::internal(format!("load tree {tree_key}: {e}")))?;
        if leaf_index >= data.next_index {
            if round + 1 == 8 {
                return Err(AppError::not_found(
                    "LEAF_NOT_FOUND",
                    format!("leaf_index {leaf_index} out of range (next={})", data.next_index),
                ));
            }
            crate::rpc::sleep_ms(150).await;
            continue;
        }
        let current_root = data.root_history[data.root_index];
        if fold_path_root(&data, leaf_index) == Ok(current_root) {
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
            return Ok(MerklePath {
                root: hex::encode_upper(current_root),
                next_leaf_index: data.next_index,
                path_elements: path,
                path_indices: indices,
            });
        }
        crate::rpc::sleep_ms(150).await;
    }
    Err(AppError::internal(format!(
        "proof {leaf_index}: mirror stayed inconsistent after retries"
    )))
}

pub async fn is_known_root(store: &Store, tree_key: &str, root: [u8; 32]) -> AppResult<bool> {
    if root == [0u8; 32] {
        return Ok(false);
    }
    let data = load_tree(store, tree_key)
        .await
        .map_err(|e| AppError::internal(format!("load tree {tree_key}: {e}")))?;
    let cur = data.root_index;
    let mut i = cur;
    loop {
        if data.root_history[i] == root {
            return Ok(true);
        }
        if i == 0 {
            i = ROOT_HISTORY_SIZE - 1;
        } else {
            i -= 1;
        }
        if i == cur {
            break;
        }
    }
    Ok(false)
}
