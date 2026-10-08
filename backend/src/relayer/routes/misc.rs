//! Read-only endpoints the SDK needs to build transactions without its own RPC:
//! fee rates, a blockhash, and raw lookup table bytes. Plus health and the float
//! metrics an operator watches.

use std::sync::atomic::Ordering;

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use solana_sdk::signer::Signer;

use crate::relayer::chain::derive_ata;
use crate::relayer::config::{ESTIMATED_TX_FEE_LAMPORTS, NULLIFIER_RENT_LAMPORTS, TRANSACT_RENT_LAMPORTS};
use crate::relayer::error::RelayerResult;
use crate::relayer::parse::parse_pubkey;
use crate::relayer::state::RelayerState;

#[derive(Serialize)]
pub struct MintInfo {
    pub mint: String,
    pub fee_ata: String,
}

#[derive(Serialize)]
pub struct RelayerInfoResponse {
    pub program_id: String,
    pub fee_recipient: String,
    pub withdrawal_fee_rate_bps: u16,
    pub deposit_fee_rate_bps: u16,
    pub fee_error_margin_bps: u16,
    pub supported_mints: Vec<MintInfo>,
    /// Rent for one nullifier marker account, and for the two a transact creates.
    /// Published so the client can compute the same fee floor the relayer enforces
    /// instead of hardcoding a constant that can drift.
    pub nullifier_rent_lamports: u64,
    pub transact_rent_lamports: u64,
    pub estimated_tx_fee_lamports: u64,
    /// The absolute minimum fee `POST /api/relayer/transact` will accept.
    pub min_transact_fee_lamports: u64,
    /// Whether this relayer can sign SPL transacts (needs a lookup table).
    pub spl_relay_available: bool,
}

pub async fn info(State(state): State<RelayerState>) -> RelayerResult<Json<RelayerInfoResponse>> {
    let rates = state.fee_rates().await?;
    let config = &state.config;
    let supported_mints = config
        .supported_mints
        .iter()
        .map(|mint| MintInfo {
            mint: mint.to_string(),
            fee_ata: derive_ata(&config.fee_recipient, mint).to_string(),
        })
        .collect();

    Ok(Json(RelayerInfoResponse {
        program_id: config.program_id.to_string(),
        fee_recipient: config.fee_recipient.to_string(),
        withdrawal_fee_rate_bps: rates.withdrawal_fee_rate_bps,
        deposit_fee_rate_bps: rates.deposit_fee_rate_bps,
        fee_error_margin_bps: rates.fee_error_margin_bps,
        supported_mints,
        nullifier_rent_lamports: NULLIFIER_RENT_LAMPORTS,
        transact_rent_lamports: TRANSACT_RENT_LAMPORTS,
        estimated_tx_fee_lamports: ESTIMATED_TX_FEE_LAMPORTS,
        min_transact_fee_lamports: config.fee_floor(),
        spl_relay_available: config.alt_address.is_some(),
    }))
}

#[derive(Serialize)]
pub struct BlockhashResponse {
    pub blockhash: String,
    pub slot: u64,
}

pub async fn blockhash(State(state): State<RelayerState>) -> RelayerResult<Json<BlockhashResponse>> {
    let info = state.rpc.get_latest_blockhash().await?;
    Ok(Json(BlockhashResponse {
        blockhash: info.blockhash.to_string(),
        // The SDK only uses this for staleness logging, and the last valid block
        // height is the more useful number for that than the current slot.
        slot: info.last_valid_block_height,
    }))
}

#[derive(Serialize)]
pub struct AltResponse {
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_hex: Option<String>,
}

/// Raw account bytes so the client can decode the table itself. Returning `exists:
/// false` rather than a 404 keeps "not created yet" off the error path, since that
/// is the normal first-run state.
pub async fn alt(
    State(state): State<RelayerState>,
    Path(address): Path<String>,
) -> RelayerResult<Json<AltResponse>> {
    let address = parse_pubkey("address", &address)?;
    match state.rpc.get_account_data(&address).await {
        Ok(Some(data)) => Ok(Json(AltResponse {
            exists: true,
            data_hex: Some(hex::encode(data)),
        })),
        // "Not created yet" is the normal first-run state, so it is an answer rather
        // than an error. An RPC failure is reported, not silently flattened.
        Ok(None) => Ok(Json(AltResponse { exists: false, data_hex: None })),
        Err(e) => Err(e),
    }
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub signer: String,
    pub fee_recipient: String,
}

pub async fn health(State(state): State<RelayerState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        signer: state.config.signer.pubkey().to_string(),
        fee_recipient: state.config.fee_recipient.to_string(),
    })
}

#[derive(Serialize)]
pub struct MetricsResponse {
    pub relayed: u64,
    pub refused: u64,
    pub failed: u64,
    /// Fees earned minus rent and transaction fees paid. Trending negative means
    /// the fee floor is set below what traffic actually costs.
    pub net_lamports: i64,
    pub fees_earned_lamports: u64,
    pub rent_paid_lamports: u64,
    pub signer_balance_lamports: u64,
    pub fee_recipient_balance_lamports: u64,
    /// True when the signer's float has run down far enough to need a sweep from
    /// the fee recipient. The signer pays nullifier rent up front on every
    /// transaction, so an empty signer stops the private paths entirely.
    pub signer_balance_low: bool,
    pub min_signer_balance_lamports: u64,
}

pub async fn metrics(State(state): State<RelayerState>) -> RelayerResult<Json<MetricsResponse>> {
    let m = &state.metrics;
    let signer_balance = state
        .rpc
        .get_balance(&state.config.signer.pubkey())
        .await
        .unwrap_or(0);
    let fee_recipient_balance = state
        .rpc
        .get_balance(&state.config.fee_recipient)
        .await
        .unwrap_or(0);

    Ok(Json(MetricsResponse {
        relayed: m.relayed.load(Ordering::Relaxed),
        refused: m.refused.load(Ordering::Relaxed),
        failed: m.failed.load(Ordering::Relaxed),
        net_lamports: m.net_lamports.load(Ordering::Relaxed),
        fees_earned_lamports: m.fees_earned_lamports.load(Ordering::Relaxed),
        rent_paid_lamports: m.rent_paid_lamports.load(Ordering::Relaxed),
        signer_balance_lamports: signer_balance,
        fee_recipient_balance_lamports: fee_recipient_balance,
        signer_balance_low: signer_balance < state.config.min_signer_balance_lamports,
        min_signer_balance_lamports: state.config.min_signer_balance_lamports,
    }))
}
