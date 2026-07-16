//! Privacy-cash relayer.
//!
//! A user who wants to withdraw shielded funds to a fresh address hands the relayer a *complete*
//! proof and the encrypted outputs; the relayer submits the transaction, paying the network fee
//! and the nullifier rent. Because the program's `signer` (fee payer) is decoupled from the
//! `recipient` — and the recipient is bound into the proof's `extDataHash`, so the relayer cannot
//! redirect it — the on-chain fee payer reveals nothing about the shielded funds.
//!
//! The relayer sets *itself* as the fee recipient. A proof built for a different fee recipient
//! simply fails on-chain (its `extDataHash` won't match), so no explicit check is needed.

mod config;
mod submit;

use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;

use config::Config;
use submit::{relay_handler, RelayState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env()?;
    let bind = config.bind.clone();
    let state = Arc::new(RelayState::new(config));

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/relay", post(relay_handler))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("relayer listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
