use axum::{
    body::Body,
    extract::{Path, State},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};

use serde_json::{json, Value};
use tower_http::request_id::RequestId;

use crate::{
    error::AppError,
    response::{ApiError, ApiResponse},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/utxos/{next_node_to_fetch}", get(utxos))
}

type Utxo = Vec<u8>;

async fn utxos(
    State(state): State<AppState>,
    Path(next_node_to_fetch): Path<u64>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<Vec<Utxo>> {
    let notes: Vec<Utxo> = match state.db.fetch_utxos(next_node_to_fetch, 1000).await {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    ApiResponse::success(notes, req_id)
}
