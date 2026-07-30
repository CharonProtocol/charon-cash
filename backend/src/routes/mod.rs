mod health;
mod indexer_status;
mod merkle;
mod notes;
mod nullifier;
mod relayer;
mod utxos;

use axum::middleware::from_fn_with_state;
use axum::routing::{get, post, put};
use axum::Router;

use crate::admin;
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    // Operator-only routes (mutating): guarded by the admin password middleware.
    let operator = Router::new()
        .route("/api/relayer/initialize", post(relayer::initialize))
        .route("/api/relayer/initialize-spl", post(relayer::initialize_spl))
        .route("/api/relayer/update-config", post(relayer::update_config))
        .route(
            "/api/relayer/update-deposit-limit",
            post(relayer::update_deposit_limit),
        )
        .route(
            "/api/relayer/update-deposit-limit-spl",
            post(relayer::update_deposit_limit_spl),
        )
        .layer(from_fn_with_state(state.clone(), admin::guard));

    Router::new()
        .route("/health", get(health::health))
        .route("/indexer/status", get(indexer_status::indexer_status))
        .route("/api/admin/verify", post(admin::verify))
        .route("/api/relayer/info", get(relayer::info))
        // Deposit: client wallet-signs, backend broadcasts (no frontend RPC submit).
        .route("/api/relayer/submit", post(relayer::submit_tx))
        // Withdraw: client proves, backend builds + signs with RELAYER_KEYPAIR.
        .route("/api/relayer", post(relayer::withdraw))
        .route("/api/relayer/transact", post(relayer::withdraw))
        .route("/api/merkle/{tree_key}", get(merkle::tree_state))
        .route("/api/merkle/{tree_key}/proof/{leaf_index}", get(merkle::proof))
        .route("/api/nullifier/{hash}", get(nullifier::status))
        .route("/api/utxos/range", get(utxos::range))
        .route("/api/utxos/check/{hex}", get(utxos::check))
        .route("/api/notes", put(notes::put))
        .route("/api/notes/{wallet}", get(notes::get))
        .merge(operator)
        .with_state(state)
}
