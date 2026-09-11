use axum::{
    body::Body,
    extract::{Path, State},
    response::Response,
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower_http::request_id::RequestId;

use crate::{
    error::AppError,
    response::{ApiError, ApiResponse},
    state::AppState,
};
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/registration/{wallet_pubkey}", get(check))
        .route("/api/registration/", post(register))
        .route(
            "/api/registration/viewing_key/{wallet_pubkey}",
            get(viewing_key),
        )
}

async fn check(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<bool> {
    let is_registered = match state.db.has_wallet_pubkey(&path).await {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    if is_registered {
        ApiResponse::success(true, req_id)
    } else {
        ApiResponse::success(false, req_id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationInfo {
    wallet_pubkey: String,
    viewingkey: Vec<u8>,
}
async fn register(
    State(state): State<AppState>,
    Extension(req_id): Extension<RequestId>,
    Json(payload): Json<RegistrationInfo>,
) -> ApiResponse<String> {
    let result = match state
        .db
        .add_user(payload.wallet_pubkey, payload.viewingkey)
        .await
    {
        Ok(n) => n,
        Err(e) => {
            return ApiResponse::error(e.into(), req_id);
        }
    };

    ApiResponse::success("User successfully added to the network".to_owned(), req_id)
}

async fn viewing_key(
    State(state): State<AppState>,
    Path(wallet_pubkey): Path<String>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<Vec<u8>> {
    let key = match state.db.get_viewing_key(wallet_pubkey).await {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    ApiResponse::success(key, req_id)
}
