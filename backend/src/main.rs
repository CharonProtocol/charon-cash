mod config;
mod db;
mod indexer;
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
use tracing_subscriber::EnvFilter;

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

    tokio::spawn(spawn_indexer(config.clone(), db.clone()));

    let rpc = Arc::new(RpcClient::new(config.solana_rpc_url.clone()));
    let keypair = Arc::new(load_keypair(&config.relayer_keypair_path)?);
    let mirror = MerkleMirror::new(db.clone(), config.program_id);
    let relayer = Arc::new(Relayer::new(rpc, keypair, config.clone(), db.clone(), mirror));

    let state = AppState {
        db,
        config: config.clone(),
        relayer,
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

fn load_keypair(path: &str) -> anyhow::Result<Keypair> {
    let bytes = std::fs::read(path)?;
    let arr: Vec<u8> = serde_json::from_slice(&bytes)
        .map_err(|e| anyhow::anyhow!("keypair file {path} must be a JSON byte array: {e}"))?;
    if arr.len() < 32 {
        anyhow::bail!("keypair file {path}: expected >=32 bytes, got {}", arr.len());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&arr[..32]);
    Ok(Keypair::new_from_array(seed))
}
