use axum::extract::{Path, State};
use axum::Json;
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

use crate::relayer::dto::{
    AltAccountResponse, BlockhashResponse, InitializeSplRequest, RelayerInfo, RelayResponse,
    SubmitRequest, UpdateConfigRequest, UpdateDepositLimitRequest, UpdateDepositLimitSplRequest,
    WithdrawRequest,
};
use crate::relayer::error::AppError;
use crate::state::AppState;

#[allow(dead_code)] // retired: withdraw is client-signed, submitted direct to RPC
pub async fn withdraw(
    State(state): State<AppState>,
    Json(req): Json<WithdrawRequest>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.relay_withdraw(req).await?))
}

pub async fn submit_tx(
    State(state): State<AppState>,
    Json(req): Json<SubmitRequest>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.broadcast(req).await?))
}

pub async fn initialize(
    State(state): State<AppState>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.initialize_default().await?))
}

pub async fn initialize_spl(
    State(state): State<AppState>,
    Json(req): Json<InitializeSplRequest>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.initialize_spl(req).await?))
}

pub async fn update_config(
    State(state): State<AppState>,
    Json(req): Json<UpdateConfigRequest>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.update_global_config(req).await?))
}

pub async fn update_deposit_limit(
    State(state): State<AppState>,
    Json(req): Json<UpdateDepositLimitRequest>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.update_deposit_limit(req).await?))
}

pub async fn update_deposit_limit_spl(
    State(state): State<AppState>,
    Json(req): Json<UpdateDepositLimitSplRequest>,
) -> Result<Json<RelayResponse>, AppError> {
    Ok(Json(state.relayer.update_deposit_limit_spl(req).await?))
}

pub async fn info(State(state): State<AppState>) -> Json<RelayerInfo> {
    Json(state.relayer.info())
}

pub async fn blockhash(State(state): State<AppState>) -> Result<Json<BlockhashResponse>, AppError> {
    Ok(Json(state.relayer.latest_blockhash().await?))
}

pub async fn alt_account(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<AltAccountResponse>, AppError> {
    let pk = Pubkey::from_str(address.trim())
        .map_err(|e| AppError::bad_request("INVALID_PUBKEY", format!("address: {e}")))?;
    Ok(Json(state.relayer.alt_account(&pk).await?))
}
