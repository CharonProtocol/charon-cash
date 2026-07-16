//! Per-tree scan feed: bulk leaves, current root, Merkle proof, bulk nullifiers.
//!
//! `key` is `sol` for the native tree or a mint's base58 address for an SPL tree.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use pc_core::MerkleTree;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

/// Max leaves returned in one page — a client pages through the tree rather than pulling it whole.
const MAX_PAGE: i64 = 1000;

type ApiResult = Result<Json<Value>, (StatusCode, Json<Value>)>;

fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": msg.into() })))
}

fn internal(e: anyhow::Error) -> (StatusCode, Json<Value>) {
    err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

#[derive(Deserialize)]
pub struct LeafRange {
    #[serde(default)]
    from: i64,
    to: Option<i64>,
}

/// `GET /tree/{key}/leaves?from=&to=` — commitments + encrypted outputs in `[from, to)`.
pub async fn leaves(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Query(range): Query<LeafRange>,
) -> ApiResult {
    let from = range.from.max(0);
    let to = range.to.unwrap_or(from + MAX_PAGE).min(from + MAX_PAGE);

    let rows = state.db.get_leaves(&key, from, to).await.map_err(internal)?;
    let leaves: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "leaf_index": r.leaf_index,
                "commitment": hex::encode(r.commitment),
                "encrypted_output": hex::encode(r.encrypted_output),
                "slot": r.slot,
            })
        })
        .collect();

    Ok(Json(json!({ "tree": key, "from": from, "leaves": leaves })))
}

/// `GET /tree/{key}/root` — the latest indexed event root and the next free leaf index.
pub async fn root(State(state): State<AppState>, Path(key): Path<String>) -> ApiResult {
    let root = state.db.latest_root(&key).await.map_err(internal)?;
    let next_index = state.db.next_index(&key).await.map_err(internal)?;
    Ok(Json(json!({
        "tree": key,
        "root": root.map(hex::encode),
        "next_index": next_index,
    })))
}

/// `GET /tree/{key}/proof/{index}` — the 26 sibling elements proving membership of a leaf.
///
/// Rebuilds the Merkle mirror from stored commitments on demand. Fine for devnet scale; a
/// production indexer would maintain the mirror incrementally.
pub async fn proof(
    State(state): State<AppState>,
    Path((key, index)): Path<(String, u64)>,
) -> ApiResult {
    let commitments = state.db.load_commitments(&key).await.map_err(internal)?;

    let mut tree = MerkleTree::new();
    for c in &commitments {
        tree.append_be32(c);
    }

    let Some(path) = tree.path_elements_be32(index) else {
        return Err(err(
            StatusCode::NOT_FOUND,
            format!("leaf {index} not in tree (next_index = {})", tree.next_index()),
        ));
    };

    let path_hex: Vec<String> = path.iter().map(hex::encode).collect();
    Ok(Json(json!({
        "tree": key,
        "leaf_index": index,
        "root": hex::encode(tree.root_be32()),
        "path_elements": path_hex,
    })))
}

#[derive(Deserialize)]
pub struct NullifierRange {
    #[serde(default)]
    from_slot: i64,
}

/// `GET /tree/{key}/nullifiers?from_slot=` — all nullifiers from a slot onward, for local
/// spent-checks. The client checks its *own* nullifiers against this set; the server never learns
/// which are the client's.
pub async fn nullifiers(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Query(range): Query<NullifierRange>,
) -> ApiResult {
    let rows = state
        .db
        .get_nullifiers(&key, range.from_slot.max(0))
        .await
        .map_err(internal)?;
    let nullifiers: Vec<String> = rows.into_iter().map(hex::encode).collect();
    Ok(Json(json!({ "tree": key, "nullifiers": nullifiers })))
}
