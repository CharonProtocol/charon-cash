use axum::{
    extract::{Path, State},
    Extension,
};
use tower_http::request_id::RequestId;

use crate::{
    response::ApiResponse,
    state::AppState,
};

type Note = (Vec<u8>, Vec<u8>);

pub async fn send_notes(
    State(state): State<AppState>,
    Path(index): Path<u64>,
    Extension(req_id): Extension<RequestId>,
) -> ApiResponse<Vec<Note>> {
    let notes: Vec<Note> = match state.db.fetch_notes(index, 1000).await {
        Ok(n) => n,
        Err(e) => return ApiResponse::error(e.into(), req_id),
    };

    ApiResponse::success(notes, req_id)
}
