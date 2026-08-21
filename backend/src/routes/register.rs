use axum::{
    body::Body,
    extract::{Path, State},
    response::Response,
    Json,
};
use serde_json::{json, Value};

use crate::{error::AppError, state::AppState};

pub async fn check_registered(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<bool, AppError> {
    let is_registered = state
        .db
        .has_wallet_pubkey(&path)
        .await
        .map_err(|_| AppError::internal("Internal Server Error"))?;

    Ok(is_registered)
}

pub async fn add_user(
    State(state): State<AppState>,
    Json(payload): Json<AddUser>,
) -> Result<Json<Value>, AppError> {
    state
        .db
        .add_user(payload.wallet_pubkey, payload.viewing_pubkey)
        .await
        .map_err(|_| |_| AppError::internal("Internal Server Error"))?;

    Ok(Json(json!({ "status": "ok" })))
}

pub async fn get_viewing_key(
    State(state): State<AppState>,
    Path(path): Path<String>,
) -> Result<Json<Value>, AppError> {
    let key = state
        .db
        .get_viewing_key(path)
        .await
        .map_err(|_| |_| AppError::internal("Internal Server Error"))?;

    Ok(Json(json!({ "key" : key })))
}

struct AddUser {
    wallet_pubkey: String,
    viewing_pubkey: Vec<u8>,
}
