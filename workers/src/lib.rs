//! privacy-cash relayer on Cloudflare Workers (workers-rs).
//!
//! Entry point per https://developers.cloudflare.com/workers/languages/rust/:
//! `#[event(fetch)]` in `src/lib.rs`, built by `worker-build` via the
//! wrangler.toml `[build]` command. All Solana interaction goes through the
//! in-crate `solana` module (solana-sdk does not compile to
//! wasm32-unknown-unknown); all state lives in D1; indexing is lazy
//! (`sync::sync_tree`) instead of an always-on Yellowstone stream.

use std::sync::Arc;

use worker::*;

mod accounts;
mod decode;
mod dto;
mod error;
mod instruction;
mod merkle;
mod relayer;
mod routes;
mod rpc;
mod solana;
mod state;
mod store;
mod sync;
mod types;
mod validate;

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let state = match state::AppState::from_env(&env) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            console_error!("env init failed: {e}");
            return Ok(error::AppError::internal(format!("worker env: {e}")).to_response());
        }
    };
    routes::router(state).run(req, env).await
}
