//! Minimal Solana JSON-RPC client over worker subrequests.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use wasm_bindgen::JsCast;
use worker::{Fetch, Method, Request, RequestInit};

use crate::solana::b58;
use crate::solana::pubkey::Pubkey;

pub struct Rpc {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SigInfo {
    pub signature: String,
    pub slot: u64,
    pub err: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct LoadedAddresses {
    pub writable: Vec<String>,
    pub readonly: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct TxJsonMeta {
    pub err: Option<Value>,
    #[serde(rename = "loadedAddresses")]
    pub loaded_addresses: Option<LoadedAddresses>,
}

#[derive(Debug, Deserialize)]
pub struct TxJsonIx {
    #[serde(rename = "programIdIndex")]
    pub program_id_index: u16,
    pub accounts: Vec<u8>,
    pub data: String,
}

#[derive(Debug, Deserialize)]
pub struct TxJsonMessage {
    #[serde(rename = "accountKeys")]
    pub account_keys: Vec<String>,
    pub instructions: Vec<TxJsonIx>,
}

#[derive(Debug, Deserialize)]
pub struct TxJsonTransaction {
    pub message: TxJsonMessage,
}

#[derive(Debug, Deserialize)]
pub struct TxJson {
    pub slot: u64,
    pub transaction: TxJsonTransaction,
    pub meta: Option<TxJsonMeta>,
}

/// Strip credential-bearing fragments from upstream error text before it can
/// surface in client responses or logs — the RPC URL embeds the provider api
/// key, and providers sometimes echo request URLs in errors.
fn scrub(mut s: String) -> String {
    for needle in ["api-key=", "apikey=", "api_key=", "token="] {
        if let Some(i) = s.find(needle) {
            s.truncate(i + needle.len());
            s.push_str("[redacted]");
        }
    }
    s
}

impl Rpc {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let body_js = wasm_bindgen::JsValue::from_str(
            &serde_json::to_string(&body).map_err(|e| e.to_string())?,
        );
        let mut init = RequestInit::new();
        init.with_method(Method::Post);
        let headers = worker::Headers::new();
        headers
            .set("content-type", "application/json")
            .map_err(|e| e.to_string())?;
        init.with_headers(headers);
        init.with_body(Some(body_js));
        let req = Request::new_with_init(&self.url, &init).map_err(|e| scrub(format!("{method}: {e}")))?;
        let mut resp = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| scrub(format!("{method}: {e}")))?;
        let status = resp.status_code();
        let text = resp
            .text()
            .await
            .map_err(|e| scrub(format!("{method}: {e}")))?;
        let value: Value = serde_json::from_str(&text).map_err(|e| {
            let detail = format!("{e}, body: {}", &text.chars().take(160).collect::<String>());
            worker::console_warn!("{method}: status {status}, {detail}");
            format!("{method}: status {status}, bad json")
        })?;
        if let Some(err) = value.get("error") {
            return Err(scrub(format!("{method}: {err}")));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| format!("{method}: missing result"))
    }

    pub async fn get_latest_blockhash(&self) -> Result<([u8; 32], u64), String> {
        let result = self.call("getLatestBlockhash", json!([{"commitment": "confirmed"}])).await?;
        let bh = result["value"]["blockhash"]
            .as_str()
            .ok_or("getLatestBlockhash: missing blockhash")?;
        let last_valid = result["value"]["lastValidBlockHeight"]
            .as_u64()
            .unwrap_or(0);
        let bytes = b58::decode(bh).ok_or("getLatestBlockhash: bad base58")?;
        let arr: [u8; 32] = bytes.try_into().map_err(|_| "getLatestBlockhash: wrong length")?;
        Ok((arr, last_valid))
    }

    pub async fn get_slot(&self) -> Result<u64, String> {
        let result = self.call("getSlot", json!([{"commitment": "confirmed"}])).await?;
        result.as_u64().ok_or_else(|| "getSlot: bad slot".into())
    }

    pub async fn get_account(&self, key: &Pubkey) -> Result<Option<Vec<u8>>, String> {
        let result = self
            .call(
                "getAccountInfo",
                json!([key.to_string(), {"encoding": "base64", "commitment": "confirmed"}]),
            )
            .await?;
        if result.get("value").map(|v| v.is_null()).unwrap_or(true) {
            return Ok(None);
        }
        let data0 = result["value"]["data"][0]
            .as_str()
            .ok_or("getAccountInfo: missing data")?;
        base64::engine::general_purpose::STANDARD
            .decode(data0)
            .map(Some)
            .map_err(|e| format!("getAccountInfo: base64: {e}"))
    }

    pub async fn get_signatures_for_address(
        &self,
        program: &Pubkey,
        before: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<SigInfo>, String> {
        let mut config = serde_json::Map::new();
        config.insert("commitment".into(), json!("confirmed"));
        if let Some(b) = before {
            config.insert("before".into(), json!(b));
        }
        if let Some(u) = until {
            config.insert("until".into(), json!(u));
        }
        let result = self
            .call("getSignaturesForAddress", json!([program.to_string(), config]))
            .await?;
        serde_json::from_value(result).map_err(|e| format!("getSignaturesForAddress: {e}"))
    }

    pub async fn get_block_signatures(&self, slot: u64) -> Result<Vec<String>, String> {
        let result = self
            .call(
                "getBlock",
                json!([
                    slot,
                    {
                        "encoding": "json",
                        "transactionDetails": "signatures",
                        "commitment": "confirmed",
                        "maxSupportedTransactionVersion": 0
                    }
                ]),
            )
            .await?;
        let sigs = result.get("signatures").cloned().unwrap_or_default();
        serde_json::from_value(sigs).map_err(|e| format!("getBlock: {e}"))
    }

    pub async fn get_transaction(&self, signature: &str) -> Result<Option<TxJson>, String> {
        let result = self
            .call(
                "getTransaction",
                json!([
                    signature,
                    {
                        "encoding": "json",
                        "commitment": "confirmed",
                        "maxSupportedTransactionVersion": 0
                    }
                ]),
            )
            .await?;
        if result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(result).map(Some).map_err(|e| format!("getTransaction: {e}"))
    }

    pub async fn simulate_transaction(&self, wire: &[u8]) -> Result<(Option<String>, Vec<String>), String> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(wire);
        let result = self
            .call(
                "simulateTransaction",
                json!([b64, { "sigVerify": false, "encoding": "base64" }]),
            )
            .await?;
        let value = &result["value"];
        let err = value["err"]
            .as_object()
            .map(|e| serde_json::to_string(&e).unwrap_or_default());
        let logs = value["logs"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|l| l.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok((err, logs))
    }

    pub async fn send_transaction(&self, wire: &[u8], skip_preflight: bool) -> Result<String, String> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(wire);
        let result = self
            .call(
                "sendTransaction",
                json!([b64, { "encoding": "base64", "skipPreflight": skip_preflight, "preflightCommitment": "confirmed" }]),
            )
            .await?;
        result
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "sendTransaction: missing signature".into())
    }

    pub async fn get_signature_status(
        &self,
        signature: &str,
    ) -> Result<Option<(String, u64)>, String> {
        let result = self
            .call("getSignatureStatuses", json!([[signature], { "searchTransactionHistory": false }]))
            .await?;
        let first = &result["value"][0];
        if first.is_null() {
            return Ok(None);
        }
        let status = first["confirmationStatus"].as_str().unwrap_or("").to_string();
        let slot = first["slot"].as_u64().unwrap_or(0);
        Ok(Some((status, slot)))
    }
}

pub async fn sleep_ms(ms: i32) {
    let promise = js_sys::Promise::new(&mut |resolve: js_sys::Function, _reject: js_sys::Function| {
        if let Ok(timer) =
            js_sys::Reflect::get(&js_sys::global(), &wasm_bindgen::JsValue::from_str("setTimeout"))
        {
            if let Ok(f) = timer.dyn_into::<js_sys::Function>() {
                let _ = f.call2(
                    &wasm_bindgen::JsValue::UNDEFINED,
                    resolve.as_ref(),
                    &wasm_bindgen::JsValue::from_f64(ms as f64),
                );
            }
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}
