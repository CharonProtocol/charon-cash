//! The `/relay` endpoint: reconstruct a proof, build the withdrawal, submit it.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use pc_client::ix::build_sol_transact_ix;
use pc_prover::ProofBytes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use solana_commitment_config::CommitmentConfig;
use solana_compute_budget_interface::ComputeBudgetInstruction;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;
use std::sync::Arc;

use crate::config::Config;

pub struct RelayState {
    config: Config,
    rpc: RpcClient,
}

impl RelayState {
    pub fn new(config: Config) -> Self {
        let rpc = RpcClient::new_with_commitment(config.rpc_url.clone(), CommitmentConfig::confirmed());
        Self { config, rpc }
    }
}

/// A complete withdrawal, everything the relayer needs to submit and nothing it needs to trust.
#[derive(Deserialize)]
pub struct RelayRequest {
    proof_a: String,               // hex, 64 bytes
    proof_b: String,               // hex, 128 bytes
    proof_c: String,               // hex, 64 bytes
    public_signals: Vec<String>,   // 7 × hex, 32 bytes
    ext_amount: i64,
    fee: u64,
    encrypted_output1: String,     // hex
    encrypted_output2: String,     // hex
    recipient: String,             // base58 pubkey
}

#[derive(Serialize)]
pub struct RelayResponse {
    signature: String,
}

fn bad(msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg.into() })))
}

fn hex_n<const N: usize>(s: &str) -> Result<[u8; N], (StatusCode, Json<Value>)> {
    let v = hex::decode(s).map_err(|_| bad("invalid hex"))?;
    v.as_slice().try_into().map_err(|_| bad(format!("expected {N} bytes")))
}

pub async fn relay_handler(
    State(state): State<Arc<RelayState>>,
    Json(req): Json<RelayRequest>,
) -> Result<Json<RelayResponse>, (StatusCode, Json<Value>)> {
    if req.ext_amount >= 0 {
        return Err(bad("relayer only submits withdrawals (ext_amount < 0)"));
    }
    if req.public_signals.len() != 7 {
        return Err(bad("expected 7 public signals"));
    }

    let mut public_signals = [[0u8; 32]; 7];
    for (slot, s) in public_signals.iter_mut().zip(&req.public_signals) {
        *slot = hex_n::<32>(s)?;
    }
    let proof = ProofBytes {
        proof_a: hex_n::<64>(&req.proof_a)?,
        proof_b: hex_n::<128>(&req.proof_b)?,
        proof_c: hex_n::<64>(&req.proof_c)?,
        public_signals,
    };

    let enc1 = hex::decode(&req.encrypted_output1).map_err(|_| bad("invalid enc1 hex"))?;
    let enc2 = hex::decode(&req.encrypted_output2).map_err(|_| bad("invalid enc2 hex"))?;
    let recipient = Pubkey::from_str(&req.recipient).map_err(|_| bad("invalid recipient"))?;

    let relayer = state.config.keypair.pubkey();
    let ix = build_sol_transact_ix(
        &proof,
        req.ext_amount,
        req.fee,
        &enc1,
        &enc2,
        recipient,
        state.config.fee_recipient,
        relayer,
    );

    // ~1M CU for the pairing, so lift the limit well above the 200k default.
    let ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
        ix,
    ];

    let blockhash = state
        .rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| bad(format!("rpc get_latest_blockhash: {e}")))?;
    let msg = Message::new(&ixs, Some(&relayer));
    let tx = Transaction::new(&[&state.config.keypair], msg, blockhash);

    let sig = state
        .rpc
        .send_and_confirm_transaction(&tx)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("submit failed: {e}") })),
            )
        })?;

    tracing::info!(%sig, %recipient, "relayed withdrawal");
    Ok(Json(RelayResponse {
        signature: sig.to_string(),
    }))
}
