use axum::{
    extract::Request,
    response::IntoResponse,
    routing::{get, post},
    Extension, Json, Router,
};
use serde_json::{json, Value};
use tower_http::request_id::RequestId;

use crate::{
    response::{req_id_to_string, ApiResponse},
    state::AppState,
};

pub fn routes() -> Router<AppState> {
    Router::new().route("/health", get(check))
}

async fn check(Extension(req_id): Extension<RequestId>) -> ApiResponse<String> {
    ApiResponse::success("The server is up and running.".to_owned(), req_id)
}
