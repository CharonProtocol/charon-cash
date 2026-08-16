use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::http::StatusCode;
use light_hasher::{Hasher, Poseidon};
use serde::Serialize;
use solana_sdk::pubkey::Pubkey;

use crate::db::Db;
use crate::relayer::accounts::MERKLE_TREE_HEIGHT;
use crate::relayer::error::{AppError, AppResult};
use crate::relayer::queries;

const ROOT_HISTORY_SIZE: usize = 100;

#[derive(Clone, Serialize)]
pub struct MerklePath {
    pub path_elements: [[u8; 32]; MERKLE_TREE_HEIGHT],
    pub path_indices: [u8; MERKLE_TREE_HEIGHT],
}

#[derive(Clone, Serialize)]
pub struct TreeState {
    pub tree_key: String,
    pub next_leaf_index: u32,
    pub current_root: String,
    pub known_roots: Vec<String>,
    pub leaf_count: i64,
}

struct Snapshot {
    built_at_next_index: u32,
    root_index: u8,
    root_history: [[u8; 32]; ROOT_HISTORY_SIZE],
    proofs: HashMap<u32, [[u8; 32]; MERKLE_TREE_HEIGHT]>,
}

pub struct MerkleMirror {
    db: Db,
    /// Stored for symmetry with `Relayer` / its account helpers (which key PDAs
    /// off the program id) but unused here: the mirror keys its trees by
    /// `tree_key`, not by program. Kept so a future per-program mirror is a
    /// one-line change.
    _program_id: Pubkey,
    cache: Arc<RwLock<HashMap<String, Snapshot>>>,
}

impl MerkleMirror {
    pub fn new(db: Db, program_id: Pubkey) -> Self {
        Self {
            db,
            _program_id: program_id,
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn ensure_fresh(&self, tree_key: &str) -> AppResult<()> {
        let db_next = self
            .db
            .next_index(tree_key)
            .await
            .map_err(|e| AppError::internal(e.to_string()))?;

        let fresh = {
            let cache = self.cache.read().expect("cache lock");
            cache
                .get(tree_key)
                .map(|s| s.built_at_next_index == db_next)
                .unwrap_or(false)
        };
        if fresh {
            return Ok(());
        }

        let leaves = self
            .db
            .load_commitments(tree_key)
            .await
            .map_err(|e| AppError::internal(e.to_string()))?;

        let zero_bytes = Poseidon::zero_bytes();
        let mut subtrees = [[0u8; 32]; MERKLE_TREE_HEIGHT];
        for i in 0..MERKLE_TREE_HEIGHT {
            subtrees[i] = zero_bytes[i];
        }
        let mut root_history = [[0u8; 32]; ROOT_HISTORY_SIZE];
        root_history[0] = zero_bytes[MERKLE_TREE_HEIGHT];

        let mut next_index: u32 = 0;
        let mut root_index: u8 = 0;
        for leaf in &leaves {
            append(
                &mut subtrees,
                &mut next_index,
                &mut root_index,
                &mut root_history,
                *leaf,
            );
        }

        let mut layers: Vec<Vec<[u8; 32]>> = Vec::with_capacity(MERKLE_TREE_HEIGHT + 1);
        layers.push(leaves.clone());
        for i in 0..MERKLE_TREE_HEIGHT {
            let prev = &layers[i];
            let mut next: Vec<[u8; 32]> = Vec::with_capacity((prev.len() + 1) / 2);
            let mut j = 0;
            while j < prev.len() {
                let left = prev[j];
                let right = if j + 1 < prev.len() {
                    prev[j + 1]
                } else {
                    zero_bytes[i]
                };
                next.push(Poseidon::hashv(&[&left, &right]).expect("poseidon hash"));
                j += 2;
            }
            layers.push(next);
        }

        let mut proofs: HashMap<u32, [[u8; 32]; MERKLE_TREE_HEIGHT]> = HashMap::new();
        for idx in 0..leaves.len() as u32 {
            let mut path = [[0u8; 32]; MERKLE_TREE_HEIGHT];
            for i in 0..MERKLE_TREE_HEIGHT {
                let sibling = ((idx >> i) ^ 1) as usize;
                path[i] = layers[i].get(sibling).copied().unwrap_or(zero_bytes[i]);
            }
            proofs.insert(idx, path);
        }

        let snap = Snapshot {
            built_at_next_index: db_next,
            root_index,
            root_history,
            proofs,
        };
        {
            let mut cache = self.cache.write().expect("cache lock");
            cache.insert(tree_key.to_string(), snap);
        }
        Ok(())
    }

    pub async fn state(&self, tree_key: &str) -> AppResult<TreeState> {
        self.ensure_fresh(tree_key).await?;
        let (next_leaf_index, root_index, root_history) = {
            let cache = self.cache.read().expect("cache lock");
            let s = cache
                .get(tree_key)
                .ok_or_else(|| AppError::internal("snapshot missing after build"))?;
            (s.built_at_next_index, s.root_index, s.root_history)
        };
        let current_root = root_history[root_index as usize];
        let known_roots = root_history
            .iter()
            .filter(|r| **r != [0u8; 32])
            .map(hex::encode_upper)
            .collect::<Vec<_>>();
        let leaf_count = queries::leaf_count(self.db.pool(), tree_key).await;
        Ok(TreeState {
            tree_key: tree_key.to_string(),
            next_leaf_index,
            current_root: hex::encode_upper(current_root),
            known_roots,
            leaf_count,
        })
    }

    pub async fn proof(&self, tree_key: &str, leaf_index: u32) -> AppResult<MerklePath> {
        self.ensure_fresh(tree_key).await?;
        let path_elements = {
            let cache = self.cache.read().expect("cache lock");
            let s = cache
                .get(tree_key)
                .ok_or_else(|| AppError::internal("snapshot missing after build"))?;
            if leaf_index >= s.built_at_next_index {
                return Err(AppError::new(
                    StatusCode::NOT_FOUND,
                    "LEAF_NOT_FOUND",
                    format!(
                        "leaf_index {leaf_index} out of range (next={})",
                        s.built_at_next_index
                    ),
                ));
            }
            s.proofs
                .get(&leaf_index)
                .copied()
                .ok_or_else(|| AppError::internal("missing cached proof"))?
        };
        let mut path_indices = [0u8; MERKLE_TREE_HEIGHT];
        for i in 0..MERKLE_TREE_HEIGHT {
            path_indices[i] = ((leaf_index >> i) & 1) as u8;
        }
        Ok(MerklePath {
            path_elements,
            path_indices,
        })
    }

    pub async fn is_known_root(&self, tree_key: &str, root: [u8; 32]) -> AppResult<bool> {
        if root == [0u8; 32] {
            return Ok(false);
        }
        self.ensure_fresh(tree_key).await?;
        let (root_index, root_history) = {
            let cache = self.cache.read().expect("cache lock");
            let s = cache
                .get(tree_key)
                .ok_or_else(|| AppError::internal("snapshot missing after build"))?;
            (s.root_index, s.root_history)
        };
        let cur = root_index as usize;
        let mut i = cur;
        loop {
            if root_history[i] == root {
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
}

#[allow(clippy::too_many_arguments)]
fn append(
    subtrees: &mut [[u8; 32]; MERKLE_TREE_HEIGHT],
    next_index: &mut u32,
    root_index: &mut u8,
    root_history: &mut [[u8; 32]; ROOT_HISTORY_SIZE],
    leaf: [u8; 32],
) -> [[u8; 32]; MERKLE_TREE_HEIGHT] {
    let zero_bytes = Poseidon::zero_bytes();
    let mut current_index = *next_index as usize;
    let mut current_level_hash = leaf;
    let mut proof = [[0u8; 32]; MERKLE_TREE_HEIGHT];

    for i in 0..MERKLE_TREE_HEIGHT {
        let zero_byte = zero_bytes[i];
        let left;
        let right;
        if current_index % 2 == 0 {
            left = current_level_hash;
            right = zero_byte;
            subtrees[i] = current_level_hash;
            proof[i] = right;
        } else {
            left = subtrees[i];
            right = current_level_hash;
            proof[i] = left;
        }
        current_level_hash = Poseidon::hashv(&[&left, &right]).expect("poseidon hash");
        current_index /= 2;
    }

    *next_index += 1;
    let new_root_index = (*root_index as usize + 1) % ROOT_HISTORY_SIZE;
    *root_index = new_root_index as u8;
    root_history[new_root_index] = current_level_hash;
    proof
}
