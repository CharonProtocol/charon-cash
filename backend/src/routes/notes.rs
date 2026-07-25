//! Encrypted note blob storage (sync/backup).
//!
//! The server stores one opaque ciphertext per wallet and cannot read it —
//! the SDK encrypts the note set with a wallet-signature-derived AES-GCM key.
//! These routes are intentionally unauthenticated: the data is ciphertext, and
//! only the wallet that produced it can decrypt it.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Deserialize)]
pub struct PutNotesRequest {
    pub wallet: String,
    /// Hex-encoded, client-encrypted note blob.
    pub ciphertext: String,
}

#[derive(Serialize)]
pub struct GetNotesResponse {
    pub wallet: String,
    pub ciphertext: String,
    pub updated_at: String,
}

/// `PUT /api/notes` — upsert the encrypted note blob for a wallet.
pub async fn put(
    State(state): State<AppState>,
    Json(req): Json<PutNotesRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    let wallet = req.wallet.trim().to_string();
    if wallet.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "wallet is required".into()));
    }
    let ciphertext = hex::decode(req.ciphertext.trim())
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid hex ciphertext: {e}")))?;

    sqlx::query(
        "INSERT INTO encrypted_notes (wallet_pubkey, ciphertext, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (wallet_pubkey)
         DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()",
    )
    .bind(&wallet)
    .bind(ciphertext.as_slice())
    .execute(state.db.pool())
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")))?;

    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/notes/{wallet}` — fetch the encrypted note blob (or 404).
pub async fn get(
    State(state): State<AppState>,
    Path(wallet): Path<String>,
) -> Result<Json<GetNotesResponse>, StatusCode> {
    let row: Option<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT ciphertext, updated_at::TEXT FROM encrypted_notes WHERE wallet_pubkey = $1",
    )
    .bind(&wallet)
    .fetch_optional(state.db.pool())
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    match row {
        Some((ciphertext, updated_at)) => Ok(Json(GetNotesResponse {
            wallet,
            ciphertext: hex::encode(&ciphertext),
            updated_at,
        })),
        None => Err(StatusCode::NOT_FOUND),
    }
}
