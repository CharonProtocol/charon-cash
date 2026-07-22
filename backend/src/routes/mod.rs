mod health;
mod indexer_status;
mod merkle;
mod nullifier;
mod relayer;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route("/indexer/status", get(indexer_status::indexer_status))
        .route("/api/relayer", post(relayer::withdraw))
        .route("/api/relayer/transact", post(relayer::withdraw))
        .route("/api/relayer/initialize", post(relayer::initialize))
        .route("/api/relayer/initialize-spl", post(relayer::initialize_spl))
        .route("/api/relayer/update-config", post(relayer::update_config))
        .route("/api/relayer/update-deposit-limit", post(relayer::update_deposit_limit))
        .route(
            "/api/relayer/update-deposit-limit-spl",
            post(relayer::update_deposit_limit_spl),
        )
        .route("/api/relayer/info", get(relayer::info))
        .route("/api/merkle/{tree_key}", get(merkle::tree_state))
        .route("/api/merkle/{tree_key}/proof/{leaf_index}", get(merkle::proof))
        .route("/api/nullifier/{hash}", get(nullifier::status))
        .with_state(state)
}
