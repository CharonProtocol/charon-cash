//! Minimal Solana JSON-RPC client.
//!
//! The relayer needs six methods. `solana-rpc-client` would bring the whole
//! account-decoder and transaction-status stack along with them, which churns fast
//! and pins the toolchain. Talking JSON-RPC directly keeps the dependency surface
//! proportional to what is actually used, and lets the raw v1 (SIMD-0385) swap
//! packet go out through the same path as everything else rather than needing a
//! separate escape hatch.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use solana_sdk::hash::Hash;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Signature;
use std::str::FromStr;
use std::time::Duration;

use crate::error::{RelayerError, RelayerResult};

pub struct RpcClient {
    url: String,
    http: reqwest::Client,
    commitment: &'static str,
}

impl RpcClient {
    /// `confirmed` rather than `finalized`: the Merkle tree advances on every
    /// transaction, so waiting for finality would age proofs out of the on-chain
    /// root history for no security gain here.
    pub fn new(url: String) -> Self {
        Self {
            url,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("build rpc http client"),
            commitment: "confirmed",
        }
    }

    async fn call(&self, method: &str, params: Value) -> RelayerResult<Value> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let response = self
            .http
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| RelayerError::upstream(format!("{method} request failed: {e}")))?;
        let json: Value = response
            .json()
            .await
            .map_err(|e| RelayerError::upstream(format!("{method} returned non-JSON: {e}")))?;

        if let Some(error) = json.get("error") {
            let message = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown rpc error");
            return Err(RelayerError::upstream(format!("{method}: {message}")));
        }
        json.get("result").cloned().ok_or_else(|| {
            RelayerError::upstream(format!("{method} response had no result field"))
        })
    }

    /// Account data, or `None` when the account does not exist. A missing account is
    /// a normal answer here — it is how an unspent nullifier is represented.
    pub async fn get_account_data(&self, address: &Pubkey) -> RelayerResult<Option<Vec<u8>>> {
        let result = self
            .call(
                "getAccountInfo",
                json!([
                    address.to_string(),
                    { "encoding": "base64", "commitment": self.commitment }
                ]),
            )
            .await?;
        decode_account_value(result.get("value"))
    }

    /// One round trip for several accounts, so checking both nullifiers costs one
    /// request rather than two.
    pub async fn get_multiple_account_data(
        &self,
        addresses: &[Pubkey],
    ) -> RelayerResult<Vec<Option<Vec<u8>>>> {
        let keys: Vec<String> = addresses.iter().map(|a| a.to_string()).collect();
        let result = self
            .call(
                "getMultipleAccounts",
                json!([keys, { "encoding": "base64", "commitment": self.commitment }]),
            )
            .await?;
        let values = result
            .get("value")
            .and_then(|v| v.as_array())
            .ok_or_else(|| RelayerError::upstream("getMultipleAccounts returned no array"))?;
        values.iter().map(|v| decode_account_value(Some(v))).collect()
    }

    pub async fn get_balance(&self, address: &Pubkey) -> RelayerResult<u64> {
        let result = self
            .call(
                "getBalance",
                json!([address.to_string(), { "commitment": self.commitment }]),
            )
            .await?;
        result
            .get("value")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| RelayerError::upstream("getBalance returned no value"))
    }

    pub async fn get_latest_blockhash(&self) -> RelayerResult<BlockhashInfo> {
        let result = self
            .call(
                "getLatestBlockhash",
                json!([{ "commitment": self.commitment }]),
            )
            .await?;
        let value = result
            .get("value")
            .ok_or_else(|| RelayerError::upstream("getLatestBlockhash returned no value"))?;
        let blockhash = value
            .get("blockhash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RelayerError::upstream("getLatestBlockhash returned no blockhash"))?;
        Ok(BlockhashInfo {
            blockhash: Hash::from_str(blockhash).map_err(|e| {
                RelayerError::upstream(format!("getLatestBlockhash returned an invalid hash: {e}"))
            })?,
            last_valid_block_height: value
                .get("lastValidBlockHeight")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        })
    }

    pub async fn simulate_transaction(&self, bytes: &[u8]) -> RelayerResult<SimulationResult> {
        let result = self
            .call(
                "simulateTransaction",
                json!([
                    encode_base64(bytes),
                    {
                        "encoding": "base64",
                        "commitment": self.commitment,
                        "sigVerify": false,
                        "replaceRecentBlockhash": false,
                    }
                ]),
            )
            .await?;
        let value = result
            .get("value")
            .ok_or_else(|| RelayerError::upstream("simulateTransaction returned no value"))?;
        Ok(SimulationResult {
            err: value.get("err").filter(|v| !v.is_null()).cloned(),
            logs: value
                .get("logs")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    pub async fn send_transaction(
        &self,
        bytes: &[u8],
        skip_preflight: bool,
    ) -> RelayerResult<Signature> {
        let result = self
            .call(
                "sendTransaction",
                json!([
                    encode_base64(bytes),
                    {
                        "encoding": "base64",
                        "skipPreflight": skip_preflight,
                        "preflightCommitment": self.commitment,
                        "maxRetries": 3,
                    }
                ]),
            )
            .await?;
        let signature = result
            .as_str()
            .ok_or_else(|| RelayerError::upstream("sendTransaction returned no signature"))?;
        Signature::from_str(signature).map_err(|e| {
            RelayerError::upstream(format!("sendTransaction returned an invalid signature: {e}"))
        })
    }

    /// `None` while the cluster has not seen the signature yet; `Some(Err)` when it
    /// landed and the program rejected it.
    pub async fn get_signature_status(
        &self,
        signature: &Signature,
    ) -> RelayerResult<Option<Result<(), String>>> {
        let result = self
            .call(
                "getSignatureStatuses",
                json!([[signature.to_string()], { "searchTransactionHistory": true }]),
            )
            .await?;
        let entry = result
            .get("value")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(Value::Null);
        if entry.is_null() {
            return Ok(None);
        }
        // Only report an outcome once the status has reached our commitment level,
        // otherwise a processed-but-dropped transaction reads as confirmed.
        let confirmed = entry
            .get("confirmationStatus")
            .and_then(|v| v.as_str())
            .map(|s| s == "confirmed" || s == "finalized")
            .unwrap_or(false);
        match entry.get("err").filter(|v| !v.is_null()) {
            Some(err) => Ok(Some(Err(err.to_string()))),
            None if confirmed => Ok(Some(Ok(()))),
            None => Ok(None),
        }
    }
}

pub struct BlockhashInfo {
    pub blockhash: Hash,
    pub last_valid_block_height: u64,
}

pub struct SimulationResult {
    pub err: Option<Value>,
    pub logs: Vec<String>,
}

#[derive(Deserialize)]
struct AccountValue {
    data: (String, String),
}

fn decode_account_value(value: Option<&Value>) -> RelayerResult<Option<Vec<u8>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let account: AccountValue = serde_json::from_value(value.clone())
        .map_err(|e| RelayerError::upstream(format!("unexpected account shape: {e}")))?;
    let (encoded, encoding) = account.data;
    if encoding != "base64" {
        return Err(RelayerError::upstream(format!(
            "account data came back as {encoding}, expected base64"
        )));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| RelayerError::upstream(format!("account data is not valid base64: {e}")))?;
    Ok(Some(bytes))
}

pub fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
