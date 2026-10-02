//! Full route table — request/response parity with the VM backend's axum
//! router, plus a guarded manual-sync endpoint for the initial backfill.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;
use worker::{Request, Response, ResponseBuilder, RouteContext, Router};

use crate::error::{AppError, AppResult};
use crate::merkle;
use crate::relayer;
use crate::state::AppState;
use crate::sync;
use crate::types::SOL_TREE_KEY;

pub fn cors(mut resp: Response) -> Response {
    let h = resp.headers_mut();
    let _ = h.set("Access-Control-Allow-Origin", "*");
    let _ = h.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    let _ = h.set("Access-Control-Allow-Headers", "content-type, x-admin-password");
    resp
}

fn ok_json<T: serde::Serialize>(v: &T) -> worker::Result<Response> {
    Ok(cors(Response::from_json(v)?))
}

fn err_json(e: AppError) -> worker::Result<Response> {
    Ok(cors(e.to_response()))
}

fn no_content() -> worker::Result<Response> {
    Ok(cors(ResponseBuilder::new().with_status(204).empty()))
}

fn state_of(ctx: &RouteContext<Arc<AppState>>) -> Arc<AppState> {
    ctx.data().clone()
}

fn query_param(url: &worker::Url, key: &str) -> Option<String> {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

fn parse_leaf_index(raw: Option<String>) -> AppResult<u32> {
    let raw = raw.ok_or_else(|| {
        AppError::bad_request("INVALID_LEAF_INDEX", "leaf_index path segment required")
    })?;
    raw.parse::<u32>()
        .map_err(|e| AppError::bad_request("INVALID_LEAF_INDEX", format!("leaf_index: {e}")))
}

const BN254_MODULUS_DEC: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const RECIPIENT_PUT_PREFIX: &str = "privacy-cash-recipients-v1";

pub fn recipient_put_message(wallet: &str, note_pubkey: &str, enc_pubkey: &str) -> String {
    format!("{RECIPIENT_PUT_PREFIX}\n{wallet}\n{note_pubkey}\n{enc_pubkey}")
}

fn valid_note_pubkey(s: &str) -> bool {
    if s.is_empty() || s.len() > BN254_MODULUS_DEC.len() {
        return false;
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if s.starts_with('0') {
        return false;
    }
    s.len() < BN254_MODULUS_DEC.len() || s.as_bytes() < BN254_MODULUS_DEC.as_bytes()
}

fn valid_enc_pubkey(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
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

fn require_admin(req: &Request, state: &AppState) -> AppResult<()> {
    let Some(stored) = state.admin_password.as_deref() else {
        return Err(AppError::unauthorized("admin password not configured"));
    };
    let Some(provided) = req.headers().get("x-admin-password").ok().flatten() else {
        return Err(AppError::unauthorized("missing x-admin-password header"));
    };
    if !ct_eq(provided.as_bytes(), stored.as_bytes()) {
        return Err(AppError::unauthorized("invalid admin password"));
    }
    Ok(())
}

fn parse_nullifier(s: &str) -> AppResult<[u8; 32]> {
    let t = s.trim();
    let stripped = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    let v = hex::decode(stripped)
        .map_err(|e| AppError::bad_request("INVALID_HEX", format!("nullifier: {e}")))?;
    let len = v.len();
    v.try_into().map_err(|_| {
        AppError::bad_request(
            "INVALID_LENGTH",
            format!("nullifier: expected 32 bytes, got {len}"),
        )
    })
}

async fn utxos_range(state: &AppState, url: &worker::Url) -> AppResult<serde_json::Value> {
    let tree_key = query_param(url, "tree_key").unwrap_or_default();
    if tree_key.is_empty() {
        return Err(AppError::bad_request("MISSING_TREE_KEY", "tree_key query param is required"));
    }
    let start = query_param(url, "start")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let end = query_param(url, "end")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(start.saturating_add(10_000));
    if end < start {
        return Err(AppError::bad_request("INVALID_RANGE", "end must be >= start"));
    }
    let end = end.min(start.saturating_add(20_000));

    let page = state
        .store
        .utxos_range(&tree_key, start, end)
        .await
        .map_err(AppError::internal)?;
    let total = state
        .store
        .leaf_count(&tree_key)
        .await
        .map_err(AppError::internal)?;
    let next_index = state
        .store
        .tree_row(&tree_key)
        .await
        .map_err(AppError::internal)?
        .map(|r| r.next_index as u64)
        .unwrap_or(0);

    let utxos: Vec<serde_json::Value> = page
        .iter()
        .map(|u| {
            json!({
                "leaf_index": u.leaf_index,
                "commitment": u.commitment_hex,
                "encrypted_output_hex": u.encrypted_output_hex,
                "signature": u.signature,
                "slot": u.slot,
            })
        })
        .collect();

    Ok(json!({
        "tree_key": tree_key,
        "start": start,
        "end": end,
        "total": total,
        "next_index": next_index,
        "has_more": end < next_index,
        "utxos": utxos,
    }))
}

async fn utxo_check(
    state: &AppState,
    hex_out: &str,
    tree_key: Option<&str>,
) -> AppResult<serde_json::Value> {
    let hex_clean = hex_out
        .strip_prefix("0x")
        .or_else(|| hex_out.strip_prefix("0X"))
        .unwrap_or(hex_out)
        .to_ascii_lowercase();
    if hex_clean.is_empty() || hex_clean.len() % 2 != 0 {
        return Err(AppError::bad_request(
            "INVALID_HEX",
            "encrypted_output_hex must be even-length hex",
        ));
    }
    let found = state
        .store
        .utxo_by_encrypted_hex(&hex_clean, tree_key)
        .await
        .map_err(AppError::internal)?;
    Ok(match found {
        Some((tk, leaf_index, commitment_hex, signature, slot)) => json!({
            "exists": true,
            "tree_key": tk,
            "leaf_index": leaf_index,
            "commitment": commitment_hex,
            "signature": signature,
            "slot": slot,
        }),
        None => json!({ "exists": false }),
    })
}

pub fn router(state: Arc<AppState>) -> Router<'static, Arc<AppState>> {
    use ed25519_dalek::Verifier;
    Router::with_data(state)
        .get_async("/health", |_req, _ctx| Box::pin(async move {
            ok_json(&json!({ "status": "ok" }))
        }))
        .get_async("/indexer/status", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let (last_signature, last_slot) = state.store.get_cursor().await.unwrap_or((None, 0));
            let sol_utxo_count = state.store.leaf_count(SOL_TREE_KEY).await.unwrap_or(0);
            ok_json(&json!({
                "last_signature": last_signature,
                "last_slot": last_slot,
                "sol_utxo_count": sol_utxo_count,
            }))
        }))
        .post_async("/api/admin/verify", |req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            if require_admin(&req, &state).is_ok() {
                ok_json(&json!({ "ok": true }))
            } else {
                err_json(AppError::unauthorized("invalid admin password"))
            }
        }))
        .post_async("/api/admin/sync", |req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            if let Err(e) = require_admin(&req, &state) {
                return err_json(e);
            }
            match sync::sync_tree_forced(&state).await {
                Ok(report) => ok_json(&json!({
                    "processed": report.new_txs,
                    "walked": report.walked,
                })),
                Err(e) => err_json(AppError::internal(format!("sync: {e}"))),
            }
        }))
        .get_async("/api/relayer/info", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            ok_json(&relayer::info(&state))
        }))
        .post_async("/api/relayer/submit", |mut req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let body: crate::dto::SubmitRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            match relayer::broadcast(&state, body).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .post_async("/api/relayer", |mut req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let body: crate::dto::WithdrawRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            match relayer::relay_withdraw(&state, body).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .post_async("/api/relayer/transact", |mut req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let body: crate::dto::WithdrawRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            match relayer::relay_withdraw(&state, body).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .get_async("/api/relayer/blockhash", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            match relayer::latest_blockhash(&state).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .get_async("/api/relayer/alt/:address", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let address = ctx.param("address").cloned().unwrap_or_default();
            let Some(address) = crate::solana::pubkey::Pubkey::parse(&address) else {
                return err_json(AppError::bad_request(
                    "INVALID_PUBKEY",
                    "address: invalid base58 pubkey",
                ));
            };
            match relayer::alt_account(&state, &address).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .get_async("/api/merkle/:tree_key", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let tree_key = ctx.param("tree_key").cloned().unwrap_or_default();
            // Read-only: serve the D1 mirror directly. The lazy sync that
            // stood here made every tree read pay a Helius poll (1-3s), which
            // serialized the engine's merkle-proof fetches; the mirror stays
            // fresh via the relay path's forced sync and the cron trigger.
            match merkle::state(&state.store, &tree_key).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .get_async("/api/merkle/:tree_key/proof/:leaf_index", |_req, ctx| {
            Box::pin(async move {
                let state = state_of(&ctx);
                let tree_key = ctx.param("tree_key").cloned().unwrap_or_default();
                let leaf_index = match parse_leaf_index(ctx.param("leaf_index").cloned()) {
                    Ok(v) => v,
                    Err(e) => return err_json(e),
                };
                // Mirror-only read (see the merkle state route note).
                match merkle::proof(&state.store, &tree_key, leaf_index).await {
                    Ok(resp) => ok_json(&resp),
                    Err(e) => err_json(e),
                }
            })
        })
        .get_async("/api/nullifier/:hash", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let hash = ctx.param("hash").cloned().unwrap_or_default();
            let bytes = match parse_nullifier(&hash) {
                Ok(b) => b,
                Err(e) => return err_json(e),
            };
            // Mirror-only read: the unlock scan fires hundreds of these; a
            // lazy sync per call was the multi-minute unlock.
            let spent_by = state
                .store
                .nullifier_spent_by(&hex::encode(bytes))
                .await
                .unwrap_or(None);
            ok_json(&json!({
                "nullifier": hash,
                "spent": spent_by.is_some(),
                "signature": spent_by,
            }))
        }))
        .post_async("/api/nullifiers/batch", |mut req, ctx| {
            Box::pin(async move {
                #[derive(Deserialize)]
                struct BatchNullifiersRequest {
                    hashes: Vec<String>,
                }
                #[derive(serde::Serialize)]
                struct BatchNullifierResult {
                    nullifier: String,
                    spent: bool,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    signature: Option<String>,
                }
                let state = state_of(&ctx);
                let body: BatchNullifiersRequest = match req.json().await {
                    Ok(b) => b,
                    Err(e) => {
                        return err_json(AppError::bad_request("INVALID_JSON", format!("{e}")))
                    }
                };
                if body.hashes.len() > 500 {
                    return err_json(AppError::bad_request(
                        "TOO_MANY_NULLIFIERS",
                        "batch is capped at 500 nullifiers",
                    ));
                }
                // Parse + normalize every hash first, then one IN query per
                // 90 (D1 binds cap at 100). Order mirrors the request.
                let mut normalized: Vec<(String, String)> =
                    Vec::with_capacity(body.hashes.len());
                for h in &body.hashes {
                    match parse_nullifier(h) {
                        Ok(b) => normalized.push((h.trim().to_string(), hex::encode(b))),
                        Err(e) => return err_json(e),
                    }
                }
                let mut out: Vec<BatchNullifierResult> = Vec::with_capacity(normalized.len());
                for chunk in normalized.chunks(90) {
                    let hexes: Vec<String> = chunk.iter().map(|(_, x)| x.clone()).collect();
                    let found = match state.store.nullifiers_spent(&hexes).await {
                        Ok(v) => v,
                        Err(e) => return err_json(AppError::internal(e)),
                    };
                    let map: std::collections::HashMap<&str, &str> =
                        found.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
                    for (orig, norm) in chunk {
                        let sig = map.get(norm.as_str()).map(|s| s.to_string());
                        out.push(BatchNullifierResult {
                            nullifier: orig.clone(),
                            spent: sig.is_some(),
                            signature: sig,
                        });
                    }
                }
                ok_json(&json!({ "results": out }))
            })
        })
        .get_async("/api/utxos/range", |req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let url = req.url()?;
            // Mirror-only read: reserve polls + scan pages hit this route
            // continuously during a run; a lazy sync per call throttled the
            // whole engine to the sync's pace.
            match utxos_range(&state, &url).await {
                Ok(v) => ok_json(&v),
                Err(e) => err_json(e),
            }
        }))
        .get_async("/api/utxos/check/:hex", |req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let hex_out = ctx.param("hex").cloned().unwrap_or_default();
            let url = req.url()?;
            // Mirror-only read (see utxos/range note).
            match utxo_check(&state, &hex_out, query_param(&url, "tree_key").as_deref()).await {
                Ok(v) => ok_json(&v),
                Err(e) => err_json(e),
            }
        }))
        .put_async("/api/notes", |mut req, ctx| Box::pin(async move {
            #[derive(Deserialize)]
            struct PutNotesRequest {
                wallet: String,
                ciphertext: String,
            }
            let state = state_of(&ctx);
            let body: PutNotesRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            let wallet = body.wallet.trim().to_string();
            if wallet.is_empty() {
                return err_json(AppError::bad_request("MISSING_WALLET", "wallet is required"));
            }
            let ciphertext_hex = body.ciphertext.trim().to_ascii_lowercase();
            if ciphertext_hex.is_empty() || hex::decode(&ciphertext_hex).is_err() {
                return err_json(AppError::bad_request("INVALID_HEX", "invalid hex ciphertext"));
            }
            match state.store.put_notes(&wallet, &ciphertext_hex).await {
                Ok(()) => no_content(),
                Err(e) => err_json(AppError::internal(e)),
            }
        }))
        .get_async("/api/notes/:wallet", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let wallet = ctx.param("wallet").cloned().unwrap_or_default();
            match state.store.get_notes(&wallet).await {
                Ok(Some((ciphertext, updated_at))) => ok_json(&json!({
                    "wallet": wallet,
                    "ciphertext": ciphertext,
                    "updated_at": updated_at,
                })),
                Ok(None) => {
                    err_json(AppError::not_found("NOT_FOUND", "no encrypted notes for this wallet"))
                }
                Err(e) => err_json(AppError::internal(e)),
            }
        }))
        .put_async("/api/recipients", |mut req, ctx| Box::pin(async move {
            #[derive(Deserialize)]
            struct PutRecipientsRequest {
                wallet: String,
                note_pubkey: String,
                enc_pubkey: String,
                signature: String,
            }
            let state = state_of(&ctx);
            let body: PutRecipientsRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            let wallet = body.wallet.trim().to_string();
            let wallet_pk = crate::solana::pubkey::Pubkey::parse(&wallet);
            if wallet_pk.is_none() {
                return err_json(AppError::bad_request(
                    "INVALID_WALLET",
                    "wallet must be a 32-byte base58 pubkey",
                ));
            }
            let note_pubkey = body.note_pubkey.trim().to_string();
            let enc_pubkey = body.enc_pubkey.trim().to_string();
            if !valid_note_pubkey(&note_pubkey) {
                return err_json(AppError::bad_request(
                    "INVALID_NOTE_PUBKEY",
                    "note_pubkey must be a canonical decimal field element below the bn254 modulus",
                ));
            }
            if !valid_enc_pubkey(&enc_pubkey) {
                return err_json(AppError::bad_request(
                    "INVALID_ENC_PUBKEY",
                    "enc_pubkey must be 64 hex chars (32 bytes)",
                ));
            }
            let sig_bytes = match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, body.signature.trim()) {
                Ok(b) => b,
                Err(_) => {
                    return err_json(AppError::bad_request(
                        "INVALID_SIGNATURE",
                        "signature must be base64 (64 bytes)",
                    ))
                }
            };
            if sig_bytes.len() != 64 {
                return err_json(AppError::bad_request(
                    "INVALID_SIGNATURE",
                    "signature must be 64 bytes",
                ));
            }
            let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes.try_into().unwrap());
            let verifying = match ed25519_dalek::VerifyingKey::from_bytes(&wallet_pk.unwrap().to_bytes()) {
                Ok(v) => v,
                Err(_) => {
                    return err_json(AppError::bad_request(
                        "INVALID_WALLET",
                        "wallet must be a 32-byte ed25519 verifying key",
                    ))
                }
            };
            let message = recipient_put_message(&wallet, &note_pubkey, &enc_pubkey);
            if verifying.verify(message.as_bytes(), &sig).is_err() {
                return err_json(AppError::bad_request(
                    "BAD_SIGNATURE",
                    "signature does not verify for this wallet and key set",
                ));
            }
            match state.store.put_recipient_keys(&wallet, &note_pubkey, &enc_pubkey).await {
                Ok(()) => no_content(),
                Err(e) => err_json(AppError::internal(e)),
            }
        }))
        .get_async("/api/recipients/:wallet", |_req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            let wallet = ctx.param("wallet").cloned().unwrap_or_default();
            match state.store.get_recipient_keys(&wallet).await {
                Ok(Some((note_pubkey, enc_pubkey, updated_at))) => ok_json(&json!({
                    "wallet": wallet,
                    "note_pubkey": note_pubkey,
                    "enc_pubkey": enc_pubkey,
                    "updated_at": updated_at,
                })),
                Ok(None) => {
                    err_json(AppError::not_found("NOT_FOUND", "no recipient keys for this wallet"))
                }
                Err(e) => err_json(AppError::internal(e)),
            }
        }))
        .post_async("/api/relayer/initialize", |req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            if let Err(e) = require_admin(&req, &state) {
                return err_json(e);
            }
            match relayer::initialize_default(&state).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .post_async("/api/relayer/initialize-spl", |mut req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            if let Err(e) = require_admin(&req, &state) {
                return err_json(e);
            }
            let body: crate::dto::InitializeSplRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            match relayer::initialize_spl(&state, body).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .post_async("/api/relayer/update-config", |mut req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            if let Err(e) = require_admin(&req, &state) {
                return err_json(e);
            }
            let body: crate::dto::UpdateConfigRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            match relayer::update_global_config(&state, body).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .post_async("/api/relayer/update-deposit-limit", |mut req, ctx| Box::pin(async move {
            let state = state_of(&ctx);
            if let Err(e) = require_admin(&req, &state) {
                return err_json(e);
            }
            let body: crate::dto::UpdateDepositLimitRequest = match req.json().await {
                Ok(b) => b,
                Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
            };
            match relayer::update_deposit_limit(&state, body).await {
                Ok(resp) => ok_json(&resp),
                Err(e) => err_json(e),
            }
        }))
        .post_async("/api/relayer/update-deposit-limit-spl", |mut req, ctx| {
            Box::pin(async move {
                let state = state_of(&ctx);
                if let Err(e) = require_admin(&req, &state) {
                    return err_json(e);
                }
                let body: crate::dto::UpdateDepositLimitSplRequest = match req.json().await {
                    Ok(b) => b,
                    Err(e) => return err_json(AppError::bad_request("INVALID_JSON", format!("{e}"))),
                };
                match relayer::update_deposit_limit_spl(&state, body).await {
                    Ok(resp) => ok_json(&resp),
                    Err(e) => err_json(e),
                }
            })
        })
        .options_async("/*catch_all", |_req, _ctx| Box::pin(async move {
            Ok(cors(ResponseBuilder::new().empty()))
        }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solana::sign::Keypair;
    use ed25519_dalek::Verifier;

    #[test]
    fn note_pubkey_validation_accepts_canonical_field_elements() {
        assert!(valid_note_pubkey("1"));
        assert!(valid_note_pubkey(
            "21888242871839275222246405745257275088548364400416034343698204186575808495616"
        ));
        assert!(!valid_note_pubkey(
            "21888242871839275222246405745257275088548364400416034343698204186575808495617"
        ));
        assert!(!valid_note_pubkey(
            "21888242871839275222246405745257275088548364400416034343698204186575808495618"
        ));
        assert!(!valid_note_pubkey("0"));
        assert!(!valid_note_pubkey("01"));
        assert!(!valid_note_pubkey(""));
        assert!(!valid_note_pubkey("12a"));
        assert!(!valid_note_pubkey("-5"));
    }

    #[test]
    fn enc_pubkey_validation_requires_32_hex_bytes() {
        assert!(valid_enc_pubkey(&"ab".repeat(32)));
        assert!(valid_enc_pubkey(&"AB".repeat(32)));
        assert!(!valid_enc_pubkey(&"ab".repeat(31)));
        assert!(!valid_enc_pubkey(&"ab".repeat(33)));
        assert!(!valid_enc_pubkey(&"zz".repeat(32)));
    }

    #[test]
    fn recipient_put_message_round_trips_ed25519() {
        let kp = Keypair::from_seed([7u8; 32]);
        let wallet = crate::solana::pubkey::Pubkey::new(kp.pubkey_bytes()).to_string();
        let note = "123456789012345678901234567890";
        let enc = "ab".repeat(32);
        let msg = recipient_put_message(&wallet, note, &enc);
        let sig = kp.sign(msg.as_bytes());
        let verifying = ed25519_dalek::VerifyingKey::from_bytes(&kp.pubkey_bytes()).unwrap();
        let sig = ed25519_dalek::Signature::from_bytes(&sig);
        assert!(verifying.verify(msg.as_bytes(), &sig).is_ok());

        let tampered = recipient_put_message(&wallet, "999", &enc);
        assert!(verifying.verify(tampered.as_bytes(), &sig).is_err());
    }
}
