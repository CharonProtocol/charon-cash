use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use rs_merkle_tree::tree::MerkleProof;
use rs_merkle_tree::Node;
use serde::ser::SerializeStruct;
use serde::Serialize;
use tower_http::request_id::RequestId;

use crate::error::AppError;
use crate::response::{ApiError, ApiResponse};
use crate::state::{AppState, TreeState};

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
        current_root: root,
        tree_key,
    };

    ApiResponse::success(tree_state, req_id)
}

pub async fn proof(
    State(state): State<AppState>,
    Path((tree_key, leaf_index1, leaf_index2)): Path<(String, u64, u64)>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<MerkleProofPair> {
    tracing::info!("Accessing merkle manager for proof generation");

    if leaf_index1 == 0 && leaf_index2 == 0 {
        tracing::info!("Both leaf indices are 0, nothing to prove.");

        return ApiResponse::error(
            ApiError::new(
                crate::response::ApiErrorCode::PoolError,
                "At least one of leaf_index1 or leaf_index2 must be non-zero.",
            ),
            req_id,
        );
    }

    let lock = state.merkle_manager.read().await;
    tracing::info!("Accessed merkle manager.");

    let token_pool = match lock.get_pool(&tree_key) {
        Some(pool) => pool,
        None => {
            tracing::info!("Pool for the specified token does not exists.");

            return ApiResponse::error(
                ApiError::new(
                    crate::response::ApiErrorCode::PoolDoesNotExists,
                    "Pool for the specified token does not exists.",
                ),
                req_id,
            );
        }
    };
    tracing::info!("Pool retreived successfully.");

    let get_proof = |index: u64,
                     fallback_root: Option<Node>|
     -> Result<MerkleProof<26>, ApiResponse<MerkleProofPair>> {
        if index == 0 {
            Ok(MerkleProof {
                proof: [Node([0u8; 32]); 26],
                leaf: Node([0u8; 32]),
                index,
                // Use the other proof's root if we have one yet, else zero.
                root: fallback_root.unwrap_or(Node([0u8; 32])),
            })
        } else {
            match token_pool.proof(index) {
                Ok(r) => {
                    tracing::info!("Merkle Proof generated successfully");
                    Ok(r)
                }
                Err(_e) => {
                    tracing::info!("Merkle Proof for the given index could not be generated");
                    Err(ApiResponse::error(
                        ApiError::new(
                            crate::response::ApiErrorCode::PoolError,
                            "Could not generate proof for the given key and index",
                        ),
                        req_id,
                    ))
                }
            }
        }
    };

    let (proof1, proof2) = if leaf_index1 != 0 {
        let proof1 = match get_proof(leaf_index1, None) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let proof2 = match get_proof(leaf_index2, Some(proof1.root.clone())) {
            Ok(p) => p,
            Err(e) => return e,
        };
        (proof1, proof2)
    } else {
        let proof2 = match get_proof(leaf_index2, None) {
            Ok(p) => p,
            Err(e) => return e,
        };
        let proof1 = match get_proof(leaf_index1, Some(proof2.root.clone())) {
            Ok(p) => p,
            Err(e) => return e,
        };
        (proof1, proof2)
    };

    ApiResponse::success(MerkleProofPair { proof1, proof2 }, req_id)
}

#[derive(Serialize, Debug)]
struct MerkleProofPair {
    proof1: MerkleProof<26>,
    proof2: MerkleProof<26>,
}

impl<const DEPTH: usize> Serialize for MerkleProof<DEPTH> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut s = serializer.serialize_struct("MerkleProof", 4)?;
        s.serialize_field("proof", &self.proof)?;
        s.serialize_field("leaf", &self.leaf)?;
        s.serialize_field("index", &self.index)?;
        s.serialize_field("root", &self.root)?;
        s.end()
    }
}

impl Serialize for Node {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_bytes(self.as_ref())
    }
}
