//! privacy-cash relayer on Cloudflare Workers (workers-rs).
//!
//! Entry point per https://developers.cloudflare.com/workers/languages/rust/:
//! `#[event(fetch)]` in `src/lib.rs`, built by `worker-build` via the
//! wrangler.toml `[build]` command. All Solana interaction goes through the
//! in-crate `solana` module (solana-sdk does not compile to
//! wasm32-unknown-unknown); all state lives in D1; indexing is lazy
//! (`sync::sync_tree`) instead of an always-on Yellowstone stream.

use std::sync::{Arc, OnceLock};

use worker::*;

mod accounts;
mod decode;
mod dto;
mod error;
mod instruction;
mod merkle;
mod neon;
mod relayer;
mod routes;
mod rpc;
mod solana;
mod state;
mod store;
mod sync;
mod types;
mod validate;

static STATE: OnceLock<std::result::Result<Arc<state::AppState>, String>> = OnceLock::new();

#[event(fetch)]
async fn main(req: Request, env: Env, ctx: Context) -> Result<Response> {
    let state = match STATE.get_or_init(|| state::AppState::from_env(&env).map(Arc::new)) {
        Ok(s) => Arc::clone(s),
        Err(e) => {
            console_error!("env init failed: {e}");
            return Ok(error::AppError::internal(format!("worker env: {e}")).to_response());
        }
    };
    let resp = routes::router(Arc::clone(&state)).run(req, env).await?;
    // Drain the post-send indexing queue: worker 0.6 exposes wait_until only
    // on this Context (not RouteContext), so the pump lives here — the relay
    // response already left; wait_until keeps the invocation alive while the
    // mirror catches up.
    for sig in relayer::drain_index_queue() {
        let st = Arc::clone(&state);
        ctx.wait_until(async move { sync::index_after_send(&st, &sig).await });
    }
    Ok(resp)
}

/// Cron tick (every minute, wrangler.toml `[triggers]`): keeps the D1 mirror
/// current while no relays are flowing, so reads — which no longer pay for a
/// lazy sync — still see recently landed deposits after an idle period.
#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, ctx: ScheduleContext) {
    let state = match STATE.get_or_init(|| state::AppState::from_env(&env).map(Arc::new)) {
        Ok(s) => Arc::clone(s),
        Err(e) => {
            console_error!("env init failed (scheduled): {e}");
            return;
        }
    };
    ctx.wait_until(async move {
        if let Err(e) = sync::sync_tree_forced(&state).await {
            console_warn!("scheduled sync failed: {e}");
        }
    })
}
