pub mod health;
pub mod indexer;
pub mod jupiter;
pub mod merkle;
pub mod register;
pub mod utxos;

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
        .merge(health::routes())
        // .route("/indexer/status", get(indexer_status::indexer_status))
        .merge(indexer::routes())
        .merge(merkle::routes())
        .merge(utxos::routes())
        .merge(register::routes())
        .route("/api/jupiter/route", post(jupiter::jupiter_route))
        .with_state(state)
}
