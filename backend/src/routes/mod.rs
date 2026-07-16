//! HTTP API.
//!
//! The privacy model is **download-and-scan-locally**: a client pulls *all* encrypted outputs and
//! *all* nullifiers and does the matching on its own device. There is deliberately no
//! `/utxos?owner=…` or `/nullifier/:n/spent` endpoint — either would let the indexer learn which
//! notes belong to whom, destroying the pool's privacy for everyone who uses a hosted indexer.

mod health;
mod indexer_status;
mod tree;

use axum::routing::get;
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route("/indexer/status", get(indexer_status::indexer_status))
        // Client scan feed: bulk leaves (commitment + encrypted output) and bulk nullifiers.
        .route("/tree/{key}/leaves", get(tree::leaves))
        .route("/tree/{key}/root", get(tree::root))
        .route("/tree/{key}/proof/{index}", get(tree::proof))
        .route("/tree/{key}/nullifiers", get(tree::nullifiers))
        .with_state(state)
}
