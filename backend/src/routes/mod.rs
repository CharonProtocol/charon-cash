mod health;
mod indexer_status;

use axum::routing::get;
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route("/indexer/status", get(indexer_status::indexer_status))
        // Teammates: add `/deposit`, `/withdraw`, `/merkle/*`, `/utxos/*` here.
        .with_state(state)
}
