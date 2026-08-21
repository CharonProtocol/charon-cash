use axum::{
    body::Body,
    extract::{Path, State},
    response::Response,
    Json,
};
use serde_json::{json, Value};

use crate::{error::AppError, state::AppState};

type Item = (Vec<u8>, Vec<u8>);

pub async fn send_notes(
    State(state): State<AppState>,
    Path(index): Path<u64>,
) -> Result<Json<Vec<Item>>, AppError> {
    let ret = state
        .db
        .fetch_notes(index, 1000)
        .await
        .map_err(|_| AppError::internal("Internal Server Error"))?;

    Ok(Json(ret))
}
