use axum::{
    extract::{Path, State},
    Extension, Json,
};
use serde::Deserialize;
use tower_http::request_id::RequestId;

use crate::{
    response::ApiResponse,
    state::AppState,
};

pub async fn check_registered(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<bool> {
    let is_registered = match state.db.has_wallet_pubkey(&path).await {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    ApiResponse::success(is_registered, req_id)
}

#[derive(Deserialize)]
pub struct AddUser {
    wallet_pubkey: String,
    viewing_pubkey: Vec<u8>,
}
pub async fn add_user(
    State(state): State<AppState>,
    Extension(req_id): Extension<RequestId>,
    Json(payload): Json<AddUser>,
) -> ApiResponse<String> {
    match state
        .db
        .add_user(payload.wallet_pubkey, payload.viewing_pubkey)
        .await
    {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    ApiResponse::success("User successfully added to the network".to_owned(), req_id)
}

pub async fn get_viewing_key(
    State(state): State<AppState>,
    Path(path): Path<String>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<Vec<u8>> {
    let key = match state.db.get_viewing_key(path).await {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    ApiResponse::success(key, req_id)
}
