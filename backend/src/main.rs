mod admin;
mod config;
mod db;
mod error;
mod indexer;
mod merkle;
mod response;
mod routes;
mod state;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::middleware::{from_fn, Next};
use axum::response::Response;
use config::Config;
use db::Db;
use indexer::spawn_indexer;
use routes::router;
use solana_sdk::signer::keypair::Keypair;
use state::AppState;
use tokio::sync::RwLock;
use tower_http::request_id::{MakeRequestId, MakeRequestUuid, RequestId};
use tracing::{info_span, Span};
use tracing_subscriber::EnvFilter;

use crate::merkle::MerkleManager;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let config = Config::from_env()?;

    let db = Db::connect(&config.database_url).await;

    let merkle_manager = Arc::new(RwLock::new(MerkleManager::new().await?));
    // Initialize the supported mints in the merkle manager
    for mint in config.supported_mints.iter() {
        merkle_manager.write().await.get_or_create_pool(&mint.to_string());
    }

    tokio::spawn(spawn_indexer(
        config.clone(),
        db.clone(),
        merkle_manager.clone(),
    ));

    let state = AppState {
        db,
        merkle_manager: merkle_manager.clone(),
        config: config.clone(),
    };

    let app = router(state)
        .layer(
            tower_http::trace::TraceLayer::new_for_http()
                .make_span_with(|request: &Request<_>| {
                    // Log the request id as generated.
                    let request_id = request.extensions().get::<RequestId>().unwrap();

                    match request_id.header_value().to_str() {
                        Ok(request_id) => {
                            info_span!(
                                "http_request",
                                request_id = %request_id,
                                method = %request.method(),
                                uri = %request.uri()
                            )
                        }
                        Err(_) => info_span!(
                            "http_request",
                            request_id = ?request_id,
                            method = %request.method(),
                            uri = %request.uri()
                        ),
                    }
                })
                .on_request(|request: &Request<_>, span: &Span| {
                    tracing::info!(
                        parent: span,
                        "Request received"
                    );
                })
                .on_response(|response: &Response<_>, latency: Duration, span: &Span| {
                    tracing::info!(
                        parent: span,
                        status = %response.status(),
                        latency = ?latency,
                        "Request completed"
                    );
                }),
        )
        .layer(from_fn(add_req_id_middleware))
        .layer(tower_http::cors::CorsLayer::permissive());

    let addr: SocketAddr = ([0, 0, 0, 0], 8080).into();
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("privacy-cash backend listening on {addr}");

    axum::serve(listener, app).await?;
    Ok(())
}

async fn add_req_id_middleware(mut req: Request, next: Next) -> Response {
    let request_id = MakeRequestUuid.make_request_id(&req);

    if let Some(id) = request_id {
        req.extensions_mut().insert(id);
    }

    next.run(req).await
}
