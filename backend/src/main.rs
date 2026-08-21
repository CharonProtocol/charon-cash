mod admin;
mod config;
mod db;
mod indexer;
mod merkle;
mod relayer;
mod routes;
mod state;

use std::net::SocketAddr;
use std::sync::Arc;

use config::Config;
use db::Db;
use indexer::spawn_indexer;
use relayer::merkle::MerkleMirror;
use relayer::Relayer;
use routes::router;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::signer::keypair::Keypair;
use state::AppState;
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::merkle::MerkleManager;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;

    let db = Db::connect(&config.database_url).await?;

    let merkle_manager = Arc::new(RwLock::new(MerkleManager::new().await?));

    tokio::spawn(spawn_indexer(config.clone(), db.clone()));

    let state = AppState {
        db,
        config: config.clone(),
    };

    let app = router(state)
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(tower_http::cors::CorsLayer::permissive());

    let addr: SocketAddr = ([0, 0, 0, 0], 8080).into();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("privacy-cash backend listening on {addr}");

    axum::serve(listener, app).await?;
    Ok(())
}
