use axum::extract::State;
use axum::{Extension, Json};
use serde::Serialize;
use serde_json::{json, Value};
use tower_http::request_id::RequestId;
use tracing::span;

use crate::indexer::SOL_TREE_KEY;
use crate::response::ApiResponse;
use crate::state::AppState;

pub async fn indexer_status(
    State(state): State<AppState>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<IndexerStatus> {
    tracing::info!("Fetching indexer status from DB");
    let (last_signature, last_slot) = match state.db.get_cursor().await {
        Ok(cursor) => cursor,
        Err(e) => {
            tracing::error!("Fetch indexer failed ", e.to_string());
            return ApiResponse::error(e.into(), req_id);
        }
    };

    tracing::info!("Fetched indexer status successfully");
    ApiResponse::success(
        IndexerStatus {
            last_signature: last_signature.unwrap_or_default(),
            last_slot: last_slot,
        },
        req_id,
    )
}

#[derive(Serialize)]
struct IndexerStatus {
    pub last_signature: String,
    pub last_slot: u64,
}
