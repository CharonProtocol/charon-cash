//! `POST /api/jupiter/route` — quote a SOL↔SPL swap and return the Jupiter instruction
//! the on-chain program will CPI. The relayer never talks to Jupiter itself; the
//! client asks here so the browser does not need Jupiter's CORS.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use solana_sdk::pubkey::Pubkey;

use crate::relayer::chain::GLOBAL_CONFIG_SEED;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRequest {
    pub input_mint: String,
    pub output_mint: String,
    pub amount: String,
    pub user_public_key: Option<String>,
    pub slippage_bps: Option<u16>,
}

#[derive(Serialize)]
struct RouteAccount {
    pubkey: String,
    #[serde(rename = "isWritable")]
    is_writable: bool,
}

#[derive(Serialize)]
struct RouteResponse {
    #[serde(rename = "minOut")]
    min_out: String,
    #[serde(rename = "outAmount")]
    out_amount: String,
    route_data: String,
    route_accounts: Vec<RouteAccount>,
}

pub async fn jupiter_route(
    State(state): State<AppState>,
    Json(req): Json<RouteRequest>,
) -> Response {
    match quote(&state, req).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": { "message": err.to_string() } })),
        )
            .into_response(),
    }
}

async fn quote(state: &AppState, req: RouteRequest) -> Result<RouteResponse, anyhow::Error> {
    if req.amount.is_empty() || req.amount.starts_with('-') {
        anyhow::bail!("amount must be a positive integer");
    }
    let slippage = req.slippage_bps.unwrap_or(100).to_string();
    let user = match req.user_public_key.filter(|key| !key.is_empty()) {
        Some(key) => key,
        None => Pubkey::find_program_address(&[GLOBAL_CONFIG_SEED], &state.config.program_id)
            .0
            .to_string(),
    };

    let client = reqwest::Client::new();
    let quote_response = client
        .get("https://lite-api.jup.ag/swap/v1/quote")
        .query(&[
            ("inputMint", req.input_mint.as_str()),
            ("outputMint", req.output_mint.as_str()),
            ("amount", req.amount.as_str()),
            ("slippageBps", slippage.as_str()),
            ("maxAccounts", "32"),
            ("onlyDirectRoutes", "true"),
            (
                "dexes",
                "Raydium,Raydium CLMM,Orca,Whirlpool,Meteora,Meteora DLMM",
            ),
        ])
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    if quote_response.get("error").is_some() {
        anyhow::bail!(
            "{}",
            quote_response["error"]
                .as_str()
                .unwrap_or("jupiter quote failed")
        );
    }

    let instructions = client
        .post("https://lite-api.jup.ag/swap/v1/swap-instructions")
        .json(&json!({
            "quoteResponse": quote_response,
            "userPublicKey": user,
            "wrapAndUnwrapSol": false,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;

    let swap_ix = instructions
        .get("swapInstruction")
        .ok_or_else(|| anyhow::anyhow!("jupiter returned no swap instruction"))?;
    let data_b64 = swap_ix
        .get("data")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow::anyhow!("jupiter swap instruction has no data"))?;
    let route_data = hex::encode(base64::engine::general_purpose::STANDARD.decode(data_b64)?);
    let route_accounts = swap_ix
        .get("accounts")
        .and_then(|value| value.as_array())
        .ok_or_else(|| anyhow::anyhow!("jupiter swap instruction has no accounts"))?
        .iter()
        .filter_map(|account| {
            Some(RouteAccount {
                pubkey: account.get("pubkey")?.as_str()?.to_string(),
                is_writable: account
                    .get("isWritable")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect();

    let out_amount = quote_response
        .get("outAmount")
        .and_then(|value| value.as_str())
        .unwrap_or("0")
        .to_string();
    let min_out = quote_response
        .get("otherAmountThreshold")
        .and_then(|value| value.as_str())
        .unwrap_or(out_amount.as_str())
        .to_string();

    Ok(RouteResponse {
        min_out,
        out_amount,
        route_data,
        route_accounts,
    })
}
