use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{
    routing::{get, post},
    Extension, Json, Router,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use num_bigint::BigUint;
use rs_merkle_tree::tree::MerkleProof;
use rs_merkle_tree::Node;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use tower_http::request_id::RequestId;

use crate::error::AppError;
use crate::response::{ApiError, ApiErrorCode, ApiResponse};
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
    commitment_string1: String, // these has to be in base64 encoding
    commitment_string2: String,
}

#[derive(Debug, Deserialize)]
pub struct ProofRouteQueryParams {
    indices: String,
    commitments: String,
}

async fn proof(
    State(state): State<AppState>,
    Path(pool_id): Path<String>,
    Query(query_params): Query<ProofRouteQueryParams>,
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
            req_id.clone(),
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
                req_id.clone(),
            );
        }
    };

    let indices = match query_params
        .indices
        .split(",")
        .map(|v| u64::from_str_radix(v, 10))
        .collect::<Result<Vec<u64>, _>>()
        .map_err(|_| {
            ApiError::new(
                ApiErrorCode::InvalidInput,
                "indices must be comma-separated unsigned integers",
            )
        }) {
        Ok(value) => value,
        Err(e) => return ApiResponse::error(e, req_id),
    };
    let commitments: Vec<&str> = query_params.commitments.split(",").collect();

    let commitment1: [u8; 32] = match commitments[0].parse::<BigUint>() {
        Ok(b) => {
            let bytes = b.to_bytes_be();
            if bytes.len() > 32 {
                return ApiResponse::error(
                    ApiError::new(
                        ApiErrorCode::InvalidInput,
                        "commitment 1 must be exactly 32 bytes",
                    ),
                    req_id.clone(),
                );
            }
            let mut arr = [0u8; 32];
            arr[32 - bytes.len()..].copy_from_slice(&bytes);
            arr
        },
        Err(_) => {
            return ApiResponse::error(
                ApiError::new(
                    ApiErrorCode::InvalidInput,
                    "commitment 1 string provided is invalid, it must be base64",
                ),
                req_id.clone(),
            );
        }
    };

    let commitment2: [u8; 32] = match commitments[1].parse::<BigUint>() {
        Ok(b) => {
            let bytes = b.to_bytes_be();
            if bytes.len() > 32 {
                return ApiResponse::error(
                    ApiError::new(
                        ApiErrorCode::InvalidInput,
                        "commitment 2 must be exactly 32 bytes",
                    ),
                    req_id.clone(),
                );
            }
            let mut arr = [0u8; 32];
            arr[32 - bytes.len()..].copy_from_slice(&bytes);
            arr
        },
        Err(_) => {
            return ApiResponse::error(
                ApiError::new(
                    ApiErrorCode::InvalidInput,
                    "commitment 2 string provided is invalid, it must be base64",
                ),
                req_id.clone(),
            );
        }
    };

    let commitment1_node = Node::from(commitment1);
    let commitment2_node = Node::from(commitment2);

    if indices[0] == 0 && indices[1] == 0 {
        let merkle_proof = ApiMerkleProof {
            root: root.as_ref().to_vec(),
            next_index: num_leaves.to_string(),
            proofs: [
                MerklePath {
                    proof: vec![Node::ZERO.as_ref().to_vec(); 26],
                    leaf: commitment1_node.as_ref().to_vec(),
                    index: "0".to_owned(),
                },
                MerklePath {
                    proof: vec![Node::ZERO.as_ref().to_vec(); 26],
                    leaf: commitment1_node.as_ref().to_vec(),
                    index: "0".to_owned(),
                },
            ],
        };

        return ApiResponse::success(merkle_proof, req_id);
    }

    let get_proof = |commitment: Node,
                     lower_bound_idx: u64,
                     upper_bound_limit: u64|
     -> Result<MerklePath, ApiResponse<ApiMerkleProof>> {
        match token_pool.proof_by_leaf(commitment, lower_bound_idx, upper_bound_limit) {
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
                Ok(MerklePath {
                    proof: vec![Node::ZERO.as_ref().to_vec(); 26],
                    leaf: Node::ZERO.as_ref().to_vec(),
                    index: "0".to_owned(),
                })
            }
        }
    };

    let (proof1, proof2) = {
        let proof1 = match get_proof(commitment1_node, indices[0], 100) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let proof2 = match get_proof(commitment2_node, indices[1], 100) {
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
