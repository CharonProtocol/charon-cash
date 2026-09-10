use axum::extract::{Path, State};
use axum::Extension;
use rs_merkle_tree::Node;
use serde::Serialize;
use tower_http::request_id::RequestId;

use crate::response::{ApiError, ApiResponse};
use crate::state::{AppState, TreeState};

#[derive(Serialize)]
pub struct MerkleProofResponse {
    pub proof: Vec<String>,
    pub leaf: String,
    pub index: u64,
    pub root: String,
}

fn node_hex(node: &Node) -> String {
    node.to_string()
}

pub async fn tree_state(
    State(state): State<AppState>,
    Path(tree_key): Path<String>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<TreeState> {
    tracing::info!("Accessing merkle manager for proof generation");

    let lock = state.merkle_manager.read().await;
    tracing::info!("Accessed merkle manager.");

    let token_pool_exists = lock.get_pool(&tree_key);

    if token_pool_exists.is_none() {
        tracing::info!("Pool for the specified token does not exists.");

        return ApiResponse::error(
            ApiError::new(
                crate::response::ApiErrorCode::PoolDoesNotExists,
                "Pool for the specified token does not exists.",
            ),
            req_id,
        );
    }

    let token_pool = token_pool_exists.unwrap();
    tracing::info!("Pool retreived successfully.");

    let num_leaves = token_pool.num_leaves();
    let root = match token_pool.root() {
        Ok(r) => {
            tracing::info!("Merkle root fetched successfully");

            r
        }
        Err(e) => {
            tracing::error!("Token pool could not be fetched");

            return ApiResponse::error(
                ApiError::new(
                    crate::response::ApiErrorCode::PoolError,
                    "Internal Error Occured",
                ),
                req_id,
            );
        }
    };

    let tree_state = TreeState {
        next_leaf_index: num_leaves,
        current_root: node_hex(&root),
        tree_key,
    };

    ApiResponse::success(tree_state, req_id)
}

pub async fn proof(
    State(state): State<AppState>,
    Path((tree_key, leaf_index)): Path<(String, u64)>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<MerkleProofResponse> {
    tracing::info!("Accessing merkle manager for proof generation");
    let lock = state.merkle_manager.read().await;
    tracing::info!("Accessed merkle manager.");

    let token_pool_exists = lock.get_pool(&tree_key);

    if token_pool_exists.is_none() {
        tracing::info!("Pool for the specified token does not exists.");

        return ApiResponse::error(
            ApiError::new(
                crate::response::ApiErrorCode::PoolDoesNotExists,
                "Pool for the specified token does not exists.",
            ),
            req_id,
        );
    }

    let token_pool = token_pool_exists.unwrap();
    tracing::info!("Pool retreived successfully.");

    let proof = match token_pool.proof(leaf_index) {
        Ok(r) => {
            tracing::info!("Merkle Proof generated successfully");

            r
        }
        Err(e) => {
            tracing::info!("Merkle Proof for the given index could not be generated");

            return ApiResponse::error(
                ApiError::new(
                    crate::response::ApiErrorCode::PoolError,
                    "Could not generated proof for the given key and index ",
                ),
                req_id,
            );
        }
    };

    ApiResponse::success(
        MerkleProofResponse {
            proof: proof.proof.iter().map(node_hex).collect(),
            leaf: node_hex(&proof.leaf),
            index: proof.index,
            root: node_hex(&proof.root),
        },
        req_id,
    )
}
