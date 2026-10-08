mod misc;
mod submit;
mod swap;
mod transact;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::relayer::state::RelayerState;

pub fn router(state: RelayerState) -> Router {
    let body_limit = state.config.max_body_bytes;

    Router::new()
        .route("/health", get(misc::health))
        .route("/metrics", get(misc::metrics))
        .route("/api/relayer/info", get(misc::info))
        .route("/api/relayer/blockhash", get(misc::blockhash))
        .route("/api/relayer/alt/{address}", get(misc::alt))
        // The relayer signs: withdrawals, transfers and swaps.
        .route("/api/relayer/transact", post(transact::transact))
        .route("/api/relayer/swap", post(swap::swap))
        // The caller signs and the relayer only forwards: deposits and ALT setup.
        .route("/api/relayer/submit", post(submit::submit))
        // Cap bodies before deserialization so an oversized request costs nothing.
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
