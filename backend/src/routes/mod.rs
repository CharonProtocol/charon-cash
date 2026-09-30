mod health;
mod indexer_status;
mod merkle;
mod notes;
mod register;

use axum::routing::{get, post};
use axum::Router;

use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    let expose_proof_route = state.config.expose_merkle_proof_route;

    let mut router = Router::new()
        .route("/health", get(health::health))
        .route("/indexer/status", get(indexer_status::indexer_status))
        .route("/api/merkle/{tree_key}", get(merkle::tree_state))
        .route("/api/merkle/{tree_key}/leaves", get(merkle::leaves))
        .route(
            "/api/registration/check/{wallet_pubkey}",
            get(register::check_registered),
        )
        .route("/api/registration/register/", post(register::add_user))
        .route(
            "/api/registration/get_viewing_key/{wallet_pubkey}",
            get(register::get_viewing_key),
        )
        .route("/api/notes/send_notes/{index}", get(notes::send_notes));

    // Per-leaf Merkle proofs are a deanonymization vector: the request identifies the
    // leaf the caller owns. Clients build the tree locally instead, so nothing needs
    // this route in production. See the doc comment on `merkle::proof`.
    if expose_proof_route {
        tracing::warn!(
            "EXPOSE_MERKLE_PROOF_ROUTE is set: /api/merkle/{{tree_key}}/proof/{{leaf_index}} is \
             served. This route lets the backend learn which leaf a caller owns; keep it off \
             outside local development."
        );
        router = router.route(
            "/api/merkle/{tree_key}/proof/{leaf_index}",
            get(merkle::proof),
        );
    }

    router.with_state(state)
}
