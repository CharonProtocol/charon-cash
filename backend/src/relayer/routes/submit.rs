//! `POST /api/relayer/submit` — dumb forwarder for already-signed transactions.
//!
//! This exists for deposits and lookup-table setup, both of which are inherently
//! public: a deposit's lamports come from the signer, and an ALT is created once
//! and shared. The relayer's only job here is to relay bytes, so it deserializes to
//! check which programs are being invoked and then forwards the transaction
//! unchanged. It never adds a signature, because doing so would let a caller use
//! this endpoint to make the relayer pay for arbitrary transactions.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::VersionedTransaction;

use crate::relayer::build::COMPUTE_BUDGET_PROGRAM_ID;
use crate::relayer::chain::{ATA_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID};
use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};
use crate::relayer::parse::decode_hex;
use crate::relayer::send::{confirm, send_with_retry, ConfirmOutcome};
use crate::relayer::state::RelayerState;

const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =
    solana_sdk::pubkey!("AddressLookupTab1e1111111111111111111111111");

#[derive(Deserialize)]
pub struct SubmitRequest {
    /// Hex-encoded, fully signed transaction bytes.
    pub transaction: String,
}

#[derive(Serialize)]
pub struct SubmitResponse {
    pub signature: String,
    pub status: &'static str,
}

pub async fn submit(
    State(state): State<RelayerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<SubmitRequest>,
) -> RelayerResult<Json<SubmitResponse>> {
    if let Err(e) = state.limiter.check(Some(peer.ip())) {
        state.metrics.record_refused();
        return Err(e);
    }

    let bytes = decode_hex("transaction", &req.transaction)?;
    let tx: VersionedTransaction = crate::relayer::wire::deserialize(&bytes)?;

    assert_programs_allowed(&state, &tx)?;
    assert_already_signed(&tx)?;

    // Forward the caller's bytes rather than a re-serialization of the decoded
    // transaction, so a signature can never be invalidated by an encoding round trip.
    let signature = send_with_retry(&state.rpc, &bytes, state.config.skip_preflight).await?;
    let status = match confirm(&state.rpc, &signature).await {
        ConfirmOutcome::Confirmed => "confirmed",
        ConfirmOutcome::Failed(reason) => {
            return Err(RelayerError::new(
                ErrorCode::TxFailed,
                format!("transaction {signature} landed but was rejected: {reason}"),
            ))
        }
        ConfirmOutcome::Unconfirmed => "submitted",
    };

    Ok(Json(SubmitResponse {
        signature: signature.to_string(),
        status,
    }))
}

/// Only forward transactions that touch the privacy-cash program or set up a lookup
/// table for it, plus the infrastructure programs those need. Without this the
/// endpoint is an open transaction relay and the operator's IP fronts for anything.
fn assert_programs_allowed(state: &RelayerState, tx: &VersionedTransaction) -> RelayerResult<()> {
    let keys = tx.message.static_account_keys();
    let allowed = [
        state.config.program_id,
        COMPUTE_BUDGET_PROGRAM_ID,
        ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        ATA_PROGRAM_ID,
        SYSTEM_PROGRAM_ID,
    ];

    let mut targets_protocol = false;
    for ix in tx.message.instructions() {
        let program_id = keys.get(ix.program_id_index as usize).ok_or_else(|| {
            RelayerError::new(
                ErrorCode::InvalidTransaction,
                "instruction references a program index outside the account list",
            )
        })?;
        if !allowed.contains(program_id) {
            return Err(RelayerError::new(
                ErrorCode::ProgramNotAllowed,
                format!(
                    "this endpoint only forwards privacy-cash transactions; it will not broadcast \
                     an instruction for {program_id}"
                ),
            ));
        }
        if *program_id == state.config.program_id
            || *program_id == ADDRESS_LOOKUP_TABLE_PROGRAM_ID
        {
            targets_protocol = true;
        }
    }

    if !targets_protocol {
        return Err(RelayerError::new(
            ErrorCode::ProgramNotAllowed,
            "transaction does not invoke the privacy-cash program or the lookup table program",
        ));
    }
    Ok(())
}

/// The caller signs; we forward. An unsigned transaction arriving here means the
/// client took the wrong path — withdrawals and transfers belong on
/// `/api/relayer/transact`, where the relayer signs on purpose.
fn assert_already_signed(tx: &VersionedTransaction) -> RelayerResult<()> {
    let required = tx.message.header().num_required_signatures as usize;
    let present = tx
        .signatures
        .iter()
        .filter(|s| **s != solana_sdk::signature::Signature::default())
        .count();
    if present < required {
        return Err(RelayerError::new(
            ErrorCode::InvalidTransaction,
            format!(
                "transaction needs {required} signatures but carries {present}. This endpoint \
                 forwards signed bytes and never signs; use /api/relayer/transact if you want the \
                 relayer to be the fee payer."
            ),
        ));
    }
    Ok(())
}
