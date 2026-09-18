mod health;
mod indexer_status;
mod merkle;
mod notes;
mod prove;
mod register;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route("/indexer/status", get(indexer_status::indexer_status))
        .route("/api/merkle/{tree_key}", get(merkle::tree_state))
        .route(
            "/api/merkle/{tree_key}/proof/{leaf_index}",
            get(merkle::proof),
        )
        .route(
            "/api/registration/check/{wallet_pubkey}",
            get(register::check_registered),
        )
        .route("/api/registration/register/", post(register::add_user))
        .route(
            "/api/registration/get_viewing_key/{wallet_pubkey}",
            get(register::get_viewing_key),
        )
        .route("/api/notes/send_notes/{index}", get(notes::send_notes))
        .route("/api/prove", post(prove::prove))
        .with_state(state)
}
