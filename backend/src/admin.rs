//! Operator authentication.
//!
//! Operator (admin) routes are guarded by a password sent in the
//! `x-admin-password` header, compared against `ADMIN_PASSWORD` from the
//! environment. If `ADMIN_PASSWORD` is unset the guard fails closed.
//!
//! This protects the *operator* endpoints only. User deposit/withdraw is
//! client-signed and submitted direct to RPC; the backend never signs or
//! submits on a user's behalf.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct VerifyResponse {
    pub ok: bool,
}

/// `POST /api/admin/verify` — checks the `x-admin-password` header.
pub async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> (StatusCode, Json<VerifyResponse>) {
    let ok = check(&state, &headers);
    let code = if ok {
        StatusCode::OK
    } else {
        StatusCode::UNAUTHORIZED
    };
    (code, Json(VerifyResponse { ok }))
}

/// Middleware guarding operator routes. Runs before the handler.
pub async fn guard(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if check(&state, &headers) {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn check(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(stored) = state.config.admin_password.as_deref() else {
        return false; // fail closed when ADMIN_PASSWORD is unset
    };
    let Some(provided) = headers
        .get("x-admin-password")
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    ct_eq(provided.as_bytes(), stored.as_bytes())
}

/// Constant-time byte equality (within a single length class).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
