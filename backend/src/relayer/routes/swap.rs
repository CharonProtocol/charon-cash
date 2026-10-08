//! `POST /api/relayer/swap` — atomic shielded swap.
//!
//! Ported from the dev shim (`frontend/scripts/backend-shim.mjs`), which was the
//! only place this ever existed. The relayer has always had to sign swaps: two
//! Groth16 proofs plus a Jupiter route only fit a v1 (SIMD-0385) packet, and wallets
//! cannot sign that format. So unlike withdrawals, relaying here is not a new trust
//! assumption — it is the existing one, moved off a development script.
//!
//! Both legs are bound by their own domain-separated `ext_data_hash`, so the same
//! reasoning applies: the relayer broadcasts, and cannot alter the trade.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;

use crate::relayer::build::{
    build_swap_instruction, build_wrap_sol_instruction, create_ata_idempotent,
    derive_swap_accounts, set_compute_unit_limit, sync_native, SwapIxParams,
};
use crate::relayer::chain::is_sol_mixer_mint;
use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};
use crate::relayer::parse::{
    decode_bounded_hex, parse_i64, parse_pubkey, ProofPayload, MAX_ENCRYPTED_OUTPUT_BYTES,
    MAX_ROUTE_DATA_BYTES,
};
use crate::relayer::send::{confirm, send_with_retry, ConfirmOutcome};
use crate::relayer::state::RelayerState;
use crate::relayer::txv1::{compile_v1_transaction, sign_v1_transaction, CompileV1Params, V1_MAX_SIZE};

const SWAP_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const MAX_ROUTE_ACCOUNTS: usize = 64;

#[derive(Deserialize)]
pub struct RouteAccount {
    pub pubkey: String,
    #[serde(default, alias = "isWritable")]
    pub is_writable: bool,
}

#[derive(Deserialize)]
pub struct SwapRequest {
    pub proof_in: ProofPayload,
    pub proof_out: ProofPayload,
    pub ext_amount_in: String,
    pub ext_amount_out: String,
    pub encrypted_output_in1: String,
    pub encrypted_output_in2: String,
    pub encrypted_output_out1: String,
    pub encrypted_output_out2: String,
    pub from_mint: String,
    pub out_mint: String,
    pub route_data: String,
    #[serde(default)]
    pub route_accounts: Vec<RouteAccount>,
}

#[derive(Serialize)]
pub struct SwapResponse {
    pub signature: String,
    pub status: &'static str,
    /// Signed packet size, so a client can see how close a route is to the 4096 cap.
    pub size: usize,
}

pub async fn swap(
    State(state): State<RelayerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<SwapRequest>,
) -> RelayerResult<Json<SwapResponse>> {
    if let Err(e) = state.limiter.check(Some(peer.ip())) {
        state.metrics.record_refused();
        return Err(e);
    }

    match relay_swap(&state, req).await {
        Ok(response) => Ok(Json(response)),
        Err(e) => {
            state.metrics.record_refused();
            Err(e)
        }
    }
}

async fn relay_swap(state: &RelayerState, req: SwapRequest) -> RelayerResult<SwapResponse> {
    let config = &state.config;
    let payer = config.signer.pubkey();

    let proof_in = req.proof_in.decode()?;
    let proof_out = req.proof_out.decode()?;
    let ext_amount_in = parse_i64("ext_amount_in", &req.ext_amount_in)?;
    let ext_amount_out = parse_i64("ext_amount_out", &req.ext_amount_out)?;

    let encrypted_output_in1 = decode_bounded_hex(
        "encrypted_output_in1",
        &req.encrypted_output_in1,
        MAX_ENCRYPTED_OUTPUT_BYTES,
    )?;
    let encrypted_output_in2 = decode_bounded_hex(
        "encrypted_output_in2",
        &req.encrypted_output_in2,
        MAX_ENCRYPTED_OUTPUT_BYTES,
    )?;
    let encrypted_output_out1 = decode_bounded_hex(
        "encrypted_output_out1",
        &req.encrypted_output_out1,
        MAX_ENCRYPTED_OUTPUT_BYTES,
    )?;
    let encrypted_output_out2 = decode_bounded_hex(
        "encrypted_output_out2",
        &req.encrypted_output_out2,
        MAX_ENCRYPTED_OUTPUT_BYTES,
    )?;
    let route_data = decode_bounded_hex("route_data", &req.route_data, MAX_ROUTE_DATA_BYTES)?;

    if req.route_accounts.len() > MAX_ROUTE_ACCOUNTS {
        return Err(RelayerError::invalid(format!(
            "route carries {} accounts, over the {MAX_ROUTE_ACCOUNTS} v1 cap",
            req.route_accounts.len()
        )));
    }
    let route_accounts = req
        .route_accounts
        .iter()
        .map(|a| Ok((parse_pubkey("route_accounts[].pubkey", &a.pubkey)?, a.is_writable)))
        .collect::<RelayerResult<Vec<(Pubkey, bool)>>>()?;

    // Direction decides which tree is spent from and which is written to. The pool
    // only supports SOL against an SPL token, never SPL against SPL.
    let sol_to_spl = is_sol_mixer_mint(&req.from_mint) && !is_sol_mixer_mint(&req.out_mint);
    let spl_to_sol = !is_sol_mixer_mint(&req.from_mint) && is_sol_mixer_mint(&req.out_mint);
    if !sol_to_spl && !spl_to_sol {
        return Err(RelayerError::invalid(
            "swap is SOL to SPL or SPL to SOL only",
        ));
    }
    let spl_mint = parse_pubkey(
        if sol_to_spl { "out_mint" } else { "from_mint" },
        if sol_to_spl { &req.out_mint } else { &req.from_mint },
    )?;

    let swap_accounts = derive_swap_accounts(&config.program_id, &spl_mint);
    let swap_ix = build_swap_instruction(&SwapIxParams {
        program_id: config.program_id,
        signer: payer,
        proof_in: &proof_in,
        proof_out: &proof_out,
        ext_amount_in,
        ext_amount_out,
        encrypted_output_in1: &encrypted_output_in1,
        encrypted_output_in2: &encrypted_output_in2,
        encrypted_output_out1: &encrypted_output_out1,
        encrypted_output_out2: &encrypted_output_out2,
        sol_to_spl,
        spl_mint,
        route_data: &route_data,
        route_accounts: &route_accounts,
    })
    .map_err(RelayerError::invalid)?;

    let mut instructions = vec![
        set_compute_unit_limit(SWAP_COMPUTE_UNIT_LIMIT),
        create_ata_idempotent(&payer, &swap_accounts.global_config, &crate::relayer::chain::NATIVE_MINT),
        create_ata_idempotent(&payer, &swap_accounts.global_config, &spl_mint),
    ];
    if sol_to_spl {
        let amount_in = ext_amount_in.unsigned_abs();
        instructions.push(build_wrap_sol_instruction(
            &config.program_id,
            &payer,
            amount_in,
        ));
        instructions.push(sync_native(&swap_accounts.pool_wsol_account));
    }
    instructions.push(swap_ix);

    let blockhash = state.rpc.get_latest_blockhash().await?.blockhash;

    let message = compile_v1_transaction(&CompileV1Params {
        fee_payer: payer,
        blockhash: Pubkey::new_from_array(blockhash.to_bytes()),
        instructions: &instructions,
        compute_unit_limit: SWAP_COMPUTE_UNIT_LIMIT,
        loaded_accounts_data_size_limit: None,
    })
    .map_err(RelayerError::invalid)?;

    let signed = sign_v1_transaction(&message, &[config.signer.as_ref()])
        .map_err(RelayerError::internal)?;
    if signed.len() > V1_MAX_SIZE {
        return Err(RelayerError::invalid(format!(
            "v1 swap packet is {} bytes, over the {V1_MAX_SIZE} cap; request a route with fewer \
             accounts",
            signed.len()
        )));
    }

    // Swaps go out with preflight skipped: the route was quoted moments ago and a
    // simulation round trip is long enough for the pool state to move under it.
    let signature = send_with_retry(&state.rpc, &signed, true).await?;
    let status = match confirm(&state.rpc, &signature).await {
        ConfirmOutcome::Confirmed => "confirmed",
        ConfirmOutcome::Failed(reason) => {
            state.metrics.record_failed();
            return Err(RelayerError::new(
                ErrorCode::TxFailed,
                format!("swap {signature} landed but was rejected: {reason}"),
            ));
        }
        ConfirmOutcome::Unconfirmed => "submitted",
    };

    Ok(Json(SwapResponse {
        signature: signature.to_string(),
        status,
        size: signed.len(),
    })
    .0)
}
