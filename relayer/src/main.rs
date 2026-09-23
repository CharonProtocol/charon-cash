//! Privacy Cash relayer.
//!
//! A withdrawal that the user's own wallet signs names that wallet as fee payer and
//! signer, directly beside the recipient and the amount. An observer links them
//! without breaking any cryptography — the ZK proof does its job and the transaction
//! envelope undoes it. This service exists so withdrawals and transfers are signed
//! by somebody with no connection to the user.
//!
//! It runs as its own process rather than inside the indexer backend. The signing
//! key is hot; the indexer holds the database and serves public reads. Keeping them
//! apart means a compromise of the read path cannot reach the key, and the two can
//! be scaled and rate-limited independently.
//!
//! The invariant to hold to, throughout: **the relayer is a broadcaster and a rent
//! payer, never an authority.** Its complete set of powers is refuse, delay, reorder
//! and observe.

mod alt;
mod build;
mod chain;
mod config;
mod error;
mod extdata;
mod float;
mod parse;
mod ratelimit;
mod routes;
mod rpc;
mod send;
mod state;
mod txv1;
mod wire;

use std::net::SocketAddr;

use anyhow::{Context, Result};
use solana_sdk::signer::Signer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,privacy_cash_relayer=debug")),
        )
        .init();

    let config = Config::from_env()?;
    let bind_addr = config.bind_addr.clone();

    tracing::info!(
        signer = %config.signer.pubkey(),
        fee_recipient = %config.fee_recipient,
        program_id = %config.program_id,
        rpc = %config.rpc_url,
        min_fee_lamports = config.fee_floor(),
        spl_relay = config.alt_address.is_some(),
        "starting relayer"
    );

    let state = AppState::new(config);

    // Warn loudly at boot rather than at the first request: an under-funded signer
    // cannot pay nullifier rent, and the private paths go down with it.
    match state.rpc.get_balance(&state.config.signer.pubkey()).await {
        Ok(balance) if balance < state.config.min_signer_balance_lamports => {
            tracing::error!(
                balance,
                minimum = state.config.min_signer_balance_lamports,
                "signer float is below the minimum; fund it before serving traffic"
            );
        }
        Ok(balance) => tracing::info!(balance, "signer float"),
        Err(e) => tracing::warn!(error = %e.message, "could not read signer balance at startup"),
    }

    float::spawn(state.clone());

    let app = routes::router(state);
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("cannot bind {bind_addr}"))?;
    tracing::info!(%bind_addr, "relayer listening");

    // `into_make_service_with_connect_info` so handlers can see the peer address for
    // per-IP rate limiting.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .context("relayer server stopped")?;

    Ok(())
}
