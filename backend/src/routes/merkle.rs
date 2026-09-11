use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{
    routing::{get, post},
    Extension, Json, Router,
};
use rs_merkle_tree::tree::MerkleProof;
use rs_merkle_tree::Node;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use tower_http::request_id::RequestId;

use crate::error::AppError;
use crate::response::{ApiError, ApiResponse};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/pools/{pool_id}/merkle", get(state))
        .route("/api/pools/{pool_id}/proof", get(proof))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeState {
    pub pool_id: String,
    pub next_leaf_index: String,
    pub current_root: Vec<u8>,
}

async fn state(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<TreeState> {
    tracing::info!("Accessing merkle manager for proof generation");

    let lock = state.merkle_manager.read().await;
    tracing::info!("Accessed merkle manager.");

    let token_pool_exists = lock.get_pool(&pool_id);

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
        next_leaf_index: num_leaves.to_string(),
        current_root: root.as_ref().to_vec(),
        pool_id: pool_id,
    };

    ApiResponse::success(tree_state, req_id)
}

#[derive(Deserialize)]
pub struct Leaves {
    leaf1: u64,
    leaf2: u64,
}

async fn proof(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
    Query(leaves): Query<Leaves>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<ApiMerkleProof> {
    tracing::info!("Accessing merkle manager for proof generation");

    let lock = state.merkle_manager.read().await;
    tracing::info!("Accessed merkle manager.");

    let token_pool_exists = lock.get_pool(&pool_id);

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

    if leaves.leaf1 == 0 && leaves.leaf2 == 0 {
        let merkle_proof = ApiMerkleProof {
            root: root.as_ref().to_vec(),
            next_index: num_leaves.to_string(),
            proofs: [
                MerklePath {
                    proof: vec![Node::ZERO.as_ref().to_vec(); 26],
                    leaf: Node::ZERO.as_ref().to_vec(),
                    index: "0".to_owned(),
                },
                MerklePath {
                    proof: vec![Node::ZERO.as_ref().to_vec(); 26],
                    leaf: Node::ZERO.as_ref().to_vec(),
                    index: "0".to_owned(),
                },
            ],
        };

        return ApiResponse::success(merkle_proof, req_id);
    }

    let get_proof = |index: u64| -> Result<MerklePath, ApiResponse<ApiMerkleProof>> {
        if index == 0 {
            Ok(MerklePath {
                proof: vec![Node::ZERO.as_ref().to_vec(); 26],
                leaf: Node::ZERO.as_ref().to_vec(),
                index: "0".to_owned(),
            })
        } else {
            match token_pool.proof(index) {
                Ok(r) => {
                    tracing::info!("Merkle Proof generated successfully");
                    Ok(MerklePath {
                        proof: r.proof.iter().map(|n| n.as_ref().to_vec()).collect(),
                        leaf: r.leaf.as_ref().to_vec(),
                        index: r.index.to_string(),
                    })
                }
                Err(_e) => {
                    tracing::info!("Merkle Proof for the given index could not be generated");
                    Err(ApiResponse::error(
                        ApiError::new(
                            crate::response::ApiErrorCode::PoolError,
                            "Could not generate proof for the given key and index",
                        ),
                        req_id.clone(),
                    ))
                }
            }
        }
    };

    let (proof1, proof2) = if leaves.leaf1 != 0 {
        let proof1 = match get_proof(leaves.leaf1) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let proof2 = match get_proof(leaves.leaf2) {
            Ok(p) => p,
            Err(e) => return e,
        };
        (proof1, proof2)
    } else {
        let proof2 = match get_proof(leaves.leaf2) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let proof1 = match get_proof(leaves.leaf1) {
            Ok(p) => p,
            Err(e) => return e,
        };
        (proof1, proof2)
    };

    ApiResponse::success(
        ApiMerkleProof {
            root: root.as_ref().to_vec(),
            next_index: num_leaves.to_string(),
            proofs: [proof1, proof2],
        },
        req_id,
    )
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApiMerkleProof {
    pub root: Vec<u8>,
    pub next_index: String,
    pub proofs: [MerklePath; 2],
}

#[derive(Serialize, Debug)]
pub struct MerklePath {
    pub proof: Vec<Vec<u8>>,
    pub leaf: Vec<u8>,
    pub index: String,
}
