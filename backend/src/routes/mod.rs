mod health;
mod indexer_status;
mod merkle;
mod notes;
mod register;

use axum::middleware::from_fn_with_state;
use axum::routing::{get, post, put};
use axum::Router;

use crate::admin;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    // // Operator-only routes (mutating): guarded by the admin password middleware.
    // let operator = Router::new()
    //     .route("/api/relayer/initialize", post(relayer::initialize))
    //     .route("/api/relayer/initialize-spl", post(relayer::initialize_spl))
    //     .route("/api/relayer/update-config", post(relayer::update_config))
    //     .route(
    //         "/api/relayer/update-deposit-limit",
    //         post(relayer::update_deposit_limit),
    //     )
    //     .route(
    //         "/api/relayer/update-deposit-limit-spl",
    //         post(relayer::update_deposit_limit_spl),
    //     )
    //     .layer(from_fn_with_state(state.clone(), admin::guard));

    Router::new()
        .route("/health", get(health::health))
        // .route("/indexer/status", get(indexer_status::indexer_status))
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
        .with_state(state)
}
