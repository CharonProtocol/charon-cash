use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;

/// Real liveness/readiness: fails if the database is unreachable, rather than always reporting
/// "ok". The indexer runs detached, so this is the only external signal that the service is wired
/// up; a hardcoded 200 would mask a dead DB.
pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match state.db.ping().await {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "ok" }))),
        Err(err) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "unavailable", "error": err.to_string() })),
        ),
    }
}
