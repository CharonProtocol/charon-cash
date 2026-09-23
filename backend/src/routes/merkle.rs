use axum::extract::{Path, Query, State};
use axum::Extension;
use rs_merkle_tree::Node;
use serde::{Deserialize, Serialize};
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

/// One page of bare commitments.
#[derive(Serialize)]
pub struct LeafRow {
    pub leaf_index: u64,
    /// 32-byte big-endian hex, no `0x`.
    pub commitment: String,
}

#[derive(Serialize)]
pub struct LeavesResponse {
    pub tree_key: String,
    pub from: u64,
    pub next_leaf_index: u64,
    pub has_more: bool,
    /// Where the next request should start. Only meaningful when `has_more`.
    pub next_from: u64,
    pub leaves: Vec<LeafRow>,
}

#[derive(Deserialize)]
pub struct LeavesQuery {
    #[serde(default)]
    pub from: u64,
}

const LEAVES_PAGE_SIZE: u16 = 2_000;

/// Commitments from `?from=N` onward.
///
/// Deliberately not a per-leaf endpoint. Clients rebuild the whole tree locally so
/// their request reveals nothing about which leaf they own; a request keyed on a leaf
/// index would make the request itself the secret. See the note above
/// `merkleForSpend` in `sdk/src/client.ts`.
///
/// Bare commitments only: the SDK discards the ciphertext and signature that
/// `/api/utxos/range` ships per leaf, so serving them is roughly an order of
/// magnitude of wasted bandwidth at no privacy benefit.
pub async fn leaves(
    State(state): State<AppState>,
    Path(tree_key): Path<String>,
    Query(query): Query<LeavesQuery>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<LeavesResponse> {
    let next_leaf_index = match state.db.next_index(&tree_key).await {
        Ok(n) => n as u64,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    let rows = match state
        .db
        .fetch_commitments(query.from, LEAVES_PAGE_SIZE, &tree_key)
        .await
    {
        Ok(r) => r,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    let leaves: Vec<LeafRow> = rows
        .into_iter()
        .map(|(leaf_index, commitment)| LeafRow {
            leaf_index,
            commitment: hex::encode(commitment),
        })
        .collect();

    let highest_returned = leaves.last().map(|l| l.leaf_index);
    let next_from = highest_returned.map(|i| i + 1).unwrap_or(query.from);
    let has_more = next_from < next_leaf_index;

    ApiResponse::success(
        LeavesResponse {
            tree_key,
            from: query.from,
            next_leaf_index,
            has_more,
            next_from,
            leaves,
        },
        req_id,
    )
}

/// Merkle proof for a single leaf.
///
/// **This route is a privacy leak and is gated behind `EXPOSE_MERKLE_PROOF_ROUTE`.**
/// The backend already knows from public deposit transactions which leaf belongs to
/// which wallet, so a proof request for a specific leaf followed by a withdrawal
/// seconds later deanonymizes it completely — and because change outputs create new
/// leaves whose proofs would also be requested, the backend could chain notes into a
/// linked list and follow a balance indefinitely. Nothing cryptographic is broken;
/// the request simply *is* the secret.
///
/// Kept for local development and debugging only. On a production backend its only
/// users are a misconfigured client and a curious operator.
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
