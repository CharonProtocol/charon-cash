use axum::{extract::Request, response::IntoResponse, Extension, Json};
use serde_json::{json, Value};
use tower_http::request_id::RequestId;

use crate::response::{req_id_to_string, ApiResponse};

pub async fn health(Extension(req_id): Extension<RequestId>) -> ApiResponse<String> {
    ApiResponse::success("The server is up and running.".to_owned(), req_id)
}
