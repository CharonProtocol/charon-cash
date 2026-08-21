use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use rs_merkle_tree::tree::MerkleProof;

use crate::error::AppError;
use crate::state::{AppState, TreeState};

pub async fn tree_state(
    State(state): State<AppState>,
    Path(tree_key): Path<String>,
) -> Result<Json<TreeState>, AppError> {
    let lock = state.merkle_manager.read().await;
    let token_pool_exists = lock.get_pool(&tree_key);

    if token_pool_exists.is_none() {
        return Err(AppError {
            status: StatusCode::NOT_FOUND,
            code: "POOL NOT FOUND",
            message: format!("Pool does not exists for the following mint."),
        });
    }

    let token_pool = token_pool_exists.unwrap();
    let num_leaves = token_pool.num_leaves();
    let root = token_pool
        .root()
        .map_err(|e| AppError::internal(e.to_string()))?;

    let tree_state = TreeState {
        next_leaf_index: num_leaves,
        current_root: root.to_string(),
        tree_key,
    };
    Ok(Json(TreeState))
}

pub async fn proof(
    State(state): State<AppState>,
    Path((tree_key, leaf_index)): Path<(String, u64)>,
) -> Result<Json<MerkleProof>, AppError> {
    let lock = state.merkle_manager.read().await;
    let token_pool_exists = lock.get_pool(&tree_key);

    if token_pool_exists.is_none() {
        return Err(AppError {
            status: StatusCode::NOT_FOUND,
            code: "POOL NOT FOUND",
            message: format!("Pool does not exists for the following mint."),
        });
    }

    let token_pool = token_pool_exists.unwrap();
    let proof = token_pool
        .proof(leaf_index)
        .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(Json(proof))
}
