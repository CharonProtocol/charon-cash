mod config;
mod db;
mod indexer;
mod routes;
mod state;

use std::net::SocketAddr;

use config::Config;
use db::Db;
use indexer::spawn_indexer;
use routes::router;
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

    // Indexer runs in the background; API stays responsive.
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
