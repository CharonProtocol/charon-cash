//! Yellowstone gRPC stream: subscribe to program txs → decode → persist via `Db`.
//!
//! Replaces RPC `getSignaturesForAddress` polling with a live Geyser subscription
//! filtered to our Pinocchio program id.

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use rs_merkle_tree::{to_node, Node};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient, ReconnectConfig};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeRequestPing, SubscribeUpdateTransactionInfo,
};
use yellowstone_grpc_proto::solana::storage::confirmed_block::Message;

use solana_sdk::pubkey::Pubkey;

use crate::config::Config;
use crate::db::Db;
use crate::merkle::{sol_address, MerkleManager};
use crate::relayer::chain::TREE_ACCOUNT_SEED;

use super::decode::{decode_swap_ix, decode_transact_ix};
use super::types::{IndexedEvent, TransactKind};

#[derive(Clone)]
pub struct Indexer {
    config: Config,
    db: Db,
    merkle_manager: Arc<RwLock<MerkleManager>>,
}

impl Indexer {
    pub fn new(config: Config, db: Db, merkle_manager: Arc<RwLock<MerkleManager>>) -> Self {
        Self {
            config,
            db,
            merkle_manager,
        }
    }

    /// Connect to Yellowstone and index forever (reconnect on stream errors).
    pub async fn run(&self) -> Result<()> {
        info!(
            program_id = %self.config.program_id,
            "indexer starting (yellowstone gRPC)"
        );

        // Use one ordered source at a time. Concurrent polling and streaming
        // could append a newer transaction before older replayed leaves.
        if self.config.indexer_rpc_fallback {
            loop {
                if let Err(err) = self.catch_up_from_rpc().await {
                    warn!(error = %err, "rpc note catch-up failed; will retry without skipping history");
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }

        loop {
            if let Err(err) = self.stream_once().await {
                warn!(error = %err, "yellowstone stream ended; reconnecting");
            }
            tokio::time::sleep(self.config.reconnect_delay()).await;
        }
    }

    async fn stream_once(&self) -> Result<()> {
        let mut builder =
            GeyserGrpcClient::build_from_shared(self.config.yellowstone_grpc_url.clone())
                .context("invalid YELLOWSTONE_GRPC_URL")?;

        if let Some(ref token) = self.config.yellowstone_x_token {
            builder = builder
                .x_token(Some(token.clone()))
                .context("invalid YELLOWSTONE_X_TOKEN")?;
        }

        // Only apply TLS if the endpoint is actually https — local surfpool is plaintext.
        if self.config.yellowstone_grpc_url.starts_with("https://") {
            builder = builder
                .tls_config(ClientTlsConfig::new().with_native_roots())
                .context("tls config")?;
        }

        let mut client = builder
            .set_reconnect_config(ReconnectConfig::default())
            .connect()
            .await
            .context("connect yellowstone gRPC")?;

        let (mut subscribe_tx, mut stream) =
            client.subscribe().await.context("yellowstone subscribe")?;

        let filter = SubscribeRequestFilterTransactions {
            vote: Some(false),
            failed: Some(false),
            account_include: vec![self.config.program_id.to_string()],
            account_exclude: vec![],
            account_required: vec![],
            signature: None,
            ..Default::default()
        };

        subscribe_tx
            .send(SubscribeRequest {
                transactions: HashMap::from([("privacy_cash".to_string(), filter)]),
                // Relayer confirms at this level; finalized adds multi-slot lag on Surfpool.
                commitment: Some(CommitmentLevel::Confirmed as i32),
                ..Default::default()
            })
            .await
            .context("send subscribe request")?;

        // Subscribe first so incoming updates queue while RPC fills any gap
        // since startup or the previous connection. Already replayed txs dedupe.
        self.catch_up_from_rpc().await?;
        info!("yellowstone subscription active");

        while let Some(message) = stream.next().await {
            let update = message.context("yellowstone stream message")?;

            match update.update_oneof {
                Some(UpdateOneof::Transaction(tx_update)) => {
                    let slot = tx_update.slot;
                    let Some(tx_info) = tx_update.transaction else {
                        continue;
                    };
                    if let Err(err) = self.handle_transaction(slot, tx_info).await {
                        warn!(error = %err, "failed to index yellowstone transaction");
                    }
                }
                Some(UpdateOneof::Ping(_)) => {
                    let _ = subscribe_tx
                        .send(SubscribeRequest {
                            ping: Some(SubscribeRequestPing { id: 1 }),
                            ..Default::default()
                        })
                        .await;
                }
                _ => {}
            }
        }

        Err(anyhow::anyhow!("yellowstone stream closed"))
    }

    async fn handle_transaction(
        &self,
        slot: u64,
        tx_info: SubscribeUpdateTransactionInfo,
    ) -> Result<()> {
        let signature = bs58::encode(&tx_info.signature).into_string();

        // This check is important for rebuilds / restarts: Yellowstone may send a transaction that was already indexed.
        if self.db.has_tx(&signature).await? {
            debug!(%signature, "already indexed");
            return Ok(());
        }

        match self.build_indexed(slot, &signature, tx_info).await? {
            Some(event) => self.persist_event(event).await?,
            None => {
                // Non-transact program ix (initialize, etc.) — still advance cursor.
                self.db.set_cursor(&signature, slot).await?;
            }
        }

        Ok(())
    }

    async fn persist_event(&self, event: IndexedEvent) -> Result<()> {
        match event {
            IndexedEvent::Transact(mut indexed) => {
                let signature = indexed.signature.clone();
                let tree_key = indexed.tree_key.clone();
                self.db.fill_commitment_and_insert_utxos(&indexed).await?;
                let mut lock = self.merkle_manager.write().await;
                let token_merkle_tree = lock.get_or_create_pool(&indexed.tree_key);
                let output_commitment1 = std::mem::take(&mut indexed.decoded.output_commitments[0]);
                let node1 = Node::from(output_commitment1);
                let output_commitment2 = std::mem::take(&mut indexed.decoded.output_commitments[1]);
                let node2 = Node::from(output_commitment2);

                token_merkle_tree.add_leaves(&[node1, node2])?;

                info!(
                    signature = %signature,
                    tree = %tree_key,
                    "indexed transact"
                );
            }
            IndexedEvent::Swap(swap) => {
                let signature = swap.signature.clone();
                let in_tree_key = swap.in_tree_key.clone();
                let out_tree_key = swap.out_tree_key.clone();
                self.db.insert_swap(&swap).await?;
                let mut lock = self.merkle_manager.write().await;
                {
                    let tree = lock.get_or_create_pool(&swap.in_tree_key);
                    tree.add_leaves(&[
                        Node::from(swap.decoded.in_commitments[0]),
                        Node::from(swap.decoded.in_commitments[1]),
                    ])?;
                }
                {
                    let tree = lock.get_or_create_pool(&swap.out_tree_key);
                    tree.add_leaves(&[
                        Node::from(swap.decoded.out_commitments[0]),
                        Node::from(swap.decoded.out_commitments[1]),
                    ])?;
                }
                info!(
                    signature = %signature,
                    in_tree = %in_tree_key,
                    out_tree = %out_tree_key,
                    "indexed swap"
                );
            }
        }
        Ok(())
    }

    async fn build_indexed(
        &self,
        slot: u64,
        signature: &str,
        tx_info: SubscribeUpdateTransactionInfo,
    ) -> Result<Option<IndexedEvent>> {
        // Yellowstone flattens ConfirmedTransaction into `transaction` + `meta`.
        if let Some(meta) = &tx_info.meta {
            if meta.err.is_some() {
                return Ok(None);
            }
        }

        let Some(message) = tx_info
            .transaction
            .as_ref()
            .and_then(|tx| tx.message.as_ref())
        else {
            return Ok(None);
        };

        // Static keys + ALT-loaded addresses (v0), in Solana account-key order.
        let mut account_keys: Vec<String> = message
            .account_keys
            .iter()
            .map(|k| bs58::encode(k).into_string())
            .collect();

        if let Some(meta) = &tx_info.meta {
            for key in &meta.loaded_writable_addresses {
                account_keys.push(bs58::encode(key).into_string());
            }
            for key in &meta.loaded_readonly_addresses {
                account_keys.push(bs58::encode(key).into_string());
            }
        }

        let program_id = self.config.program_id.to_string();
        let instructions = program_instructions(message, &account_keys, &program_id);
        if instructions.is_empty() {
            return Ok(None);
        }

        // A swap transaction also carries wrap_sol. Index the swap when it is present.
        if let Some((ix_data, accounts)) = instructions
            .iter()
            .find(|(data, _)| data.first().copied() == Some(super::decode::SWAP))
        {
            let decoded = match decode_swap_ix(ix_data) {
                Ok(decoded) => decoded,
                Err(err) => {
                    warn!(%signature, error = %err, "swap instruction did not decode");
                    return Ok(None);
                }
            };
            // Account 0 is the spent tree. The SOL tree is `[merkle_tree]`; the SPL mint is account 14.
            let sol_tree =
                Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], &self.config.program_id)
                    .0
                    .to_string();
            let Some(in_tree) = accounts.first() else {
                return Ok(None);
            };
            let Some(spl_mint) = accounts.get(14) else {
                warn!(%signature, "swap instruction is missing the SPL mint account");
                return Ok(None);
            };
            let (in_tree_key, out_tree_key) = if in_tree == &sol_tree {
                (sol_address(), spl_mint.clone())
            } else {
                (spl_mint.clone(), sol_address())
            };
            let in_index = self.db.next_index(&in_tree_key).await?;
            let out_index = self.db.next_index(&out_tree_key).await?;
            return Ok(Some(IndexedEvent::Swap(super::types::IndexedSwap {
                signature: signature.to_string(),
                slot,
                in_tree_key,
                out_tree_key,
                in_index,
                out_index,
                decoded,
            })));
        }

        let Some((ix_data, accounts)) = instructions.iter().find(|(data, _)| {
            matches!(
                data.first().copied(),
                Some(super::decode::TRANSACT | super::decode::TRANSACT_SPL)
            )
        }) else {
            return Ok(None);
        };

        let decoded = match decode_transact_ix(ix_data) {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        let tree_key = match decoded.kind {
            TransactKind::Sol => sol_address(),
            // TransactSpl account layout: mint is index 7.
            TransactKind::Spl => accounts
                .get(7)
                .cloned()
                .unwrap_or_else(|| "unknown_mint".to_string()),
        };

        let start_index = self.db.next_index(&tree_key).await?;

        Ok(Some(IndexedEvent::Transact(
            super::types::IndexedTransact {
                curr_index: start_index,
                signature: signature.to_string(),
                slot,
                tree_key,
                decoded,
            },
        )))
    }

    /// Replay from the persisted cursor, across every RPC page, oldest first.
    /// A failed fetch aborts replay so no later leaf can overtake a missing one.
    pub async fn catch_up_from_rpc(&self) -> Result<()> {
        let rpc = std::env::var("SOLANA_RPC_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8899".to_string());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30)).build()?;
        let (cursor, _) = self.db.get_cursor().await?;
        let pending = signature_history(&client, &rpc, &self.config.program_id.to_string(), cursor.as_deref()).await?;
        for entry in &pending {
            let signature = entry["signature"].as_str().context("RPC signature missing")?;
            let slot = entry["slot"].as_u64().context("RPC signature slot missing")?;
            if entry["err"].is_null() && !self.db.has_tx(signature).await? {
                self.index_rpc_transaction(&client, &rpc, signature, slot).await?;
            }
            self.db.set_cursor(signature, slot).await?;
        }
        Ok(())
    }

    pub async fn verify_roots(&self) -> Result<()> {
        use crate::relayer::chain::{derive_spl_tree_account, parse_tree_account};
        let rpc = crate::relayer::rpc::RpcClient::new(std::env::var("SOLANA_RPC_URL")?);
        for mint in &self.config.supported_mints {
            let tree_address = if mint.to_string() == sol_address() {
                Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], &self.config.program_id).0
            } else {
                derive_spl_tree_account(&self.config.program_id, mint)
            };
            let bytes = rpc.get_account_data(&tree_address).await
                .map_err(|error| anyhow::anyhow!("{}", error.message))?
                .context("configured pool is not initialized on-chain")?;
            let snapshot = parse_tree_account(&bytes)
                .map_err(|error| anyhow::anyhow!("{}", error.message))?;
            let manager = self.merkle_manager.read().await;
            let tree = manager.get_pool(&mint.to_string()).context("indexed pool missing")?;
            anyhow::ensure!(tree.num_leaves() == snapshot.next_index as u64,
                "pool {mint}: indexed {} leaves but chain has {}; history is incomplete", tree.num_leaves(), snapshot.next_index);
            let root = tree.root()?;
            anyhow::ensure!(snapshot.roots.iter().any(|known| known.as_slice() == root.as_ref()),
                "pool {mint}: indexed root is absent from on-chain history");
            info!(mint = %mint, leaves = tree.num_leaves(), "indexed pool verified against chain");
        }
        Ok(())
    }

    async fn index_rpc_transaction(
        &self,
        client: &reqwest::Client,
        rpc: &str,
        signature: &str,
        slot: u64,
    ) -> Result<()> {
        let result = rpc_result(client, rpc, "getTransaction", serde_json::json!([signature, {
            "encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0
        }])).await?;
        anyhow::ensure!(!result.is_null(), "transaction {signature} is not yet available from RPC");
        if !result["meta"]["err"].is_null() {
            return Ok(());
        }

        let message = &result["transaction"]["message"];
        let mut account_keys: Vec<String> = message["accountKeys"]
            .as_array()
            .map(|keys| {
                keys.iter()
                    .filter_map(|key| key.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        for field in ["writable", "readonly"] {
            if let Some(extra) = result["meta"]["loadedAddresses"][field].as_array() {
                for key in extra {
                    if let Some(key) = key.as_str() {
                        account_keys.push(key.to_string());
                    }
                }
            }
        }

        let program_id = self.config.program_id.to_string();
        let Some(instructions) = message["instructions"].as_array() else {
            return Ok(());
        };

        for ix in instructions {
            let Some(program_index) = ix["programIdIndex"].as_u64() else {
                continue;
            };
            if account_keys.get(program_index as usize) != Some(&program_id) {
                continue;
            }
            let Some(data_b58) = ix["data"].as_str() else {
                continue;
            };
            let data = bs58::decode(data_b58)
                .into_vec()
                .context("instruction data is not base58")?;
            let accounts = ix["accounts"]
                .as_array()
                .map(|indexes| {
                    indexes
                        .iter()
                        .filter_map(|index| index.as_u64())
                        .filter_map(|index| account_keys.get(index as usize).cloned())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            if let Some(event) = self
                .event_from_instruction(signature, slot, &data, &accounts)
                .await?
            {
                self.persist_event(event).await?;
                return Ok(());
            }
        }
        Ok(())
    }

    async fn event_from_instruction(
        &self,
        signature: &str,
        slot: u64,
        data: &[u8],
        accounts: &[String],
    ) -> Result<Option<IndexedEvent>> {
        if data.first().copied() == Some(super::decode::SWAP) {
            let decoded = match super::decode::decode_swap_ix(data) {
                Ok(decoded) => decoded,
                Err(err) => {
                    warn!(%signature, error = %err, "swap instruction did not decode");
                    return Ok(None);
                }
            };
            let sol_tree =
                Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], &self.config.program_id)
                    .0
                    .to_string();
            let Some(in_tree) = accounts.first() else {
                return Ok(None);
            };
            let Some(spl_mint) = accounts.get(14) else {
                warn!(%signature, "swap instruction is missing the SPL mint account");
                return Ok(None);
            };
            let (in_tree_key, out_tree_key) = if in_tree == &sol_tree {
                (sol_address(), spl_mint.clone())
            } else {
                (spl_mint.clone(), sol_address())
            };
            let in_index = self.db.next_index(&in_tree_key).await?;
            let out_index = self.db.next_index(&out_tree_key).await?;
            return Ok(Some(IndexedEvent::Swap(super::types::IndexedSwap {
                signature: signature.to_string(),
                slot,
                in_tree_key,
                out_tree_key,
                in_index,
                out_index,
                decoded,
            })));
        }

        if !matches!(
            data.first().copied(),
            Some(super::decode::TRANSACT | super::decode::TRANSACT_SPL)
        ) {
            return Ok(None);
        }

        let decoded = match super::decode::decode_transact_ix(data) {
            Ok(decoded) => decoded,
            Err(err) => {
                warn!(%signature, error = %err, "transact instruction did not decode");
                return Ok(None);
            }
        };
        let tree_key = match decoded.kind {
            TransactKind::Sol => sol_address(),
            TransactKind::Spl => accounts
                .get(7)
                .cloned()
                .unwrap_or_else(|| "unknown_mint".to_string()),
        };
        let start_index = self.db.next_index(&tree_key).await?;
        Ok(Some(IndexedEvent::Transact(
            super::types::IndexedTransact {
                curr_index: start_index,
                signature: signature.to_string(),
                slot,
                tree_key,
                decoded,
            },
        )))
    }
}

async fn signature_history(client: &reqwest::Client, rpc: &str, program: &str, cursor: Option<&str>) -> Result<Vec<serde_json::Value>> {
        let mut before: Option<String> = None;
        let mut pending = Vec::new();
        loop {
            let mut options = serde_json::json!({"limit": 1000, "commitment": "confirmed"});
            if let Some(signature) = cursor { options["until"] = signature.into(); }
            if let Some(ref signature) = before { options["before"] = signature.clone().into(); }
            let page = rpc_result(client, rpc, "getSignaturesForAddress",
                serde_json::json!([program, options])).await?;
            let entries = page.as_array().context("RPC signature list is not an array")?;
            if entries.is_empty() { break; }
            let last = entries.last().and_then(|entry| entry["signature"].as_str())
                .context("RPC signature entry is missing its signature")?.to_owned();
            anyhow::ensure!(before.as_ref() != Some(&last), "RPC pagination did not advance");
            pending.extend(entries.iter().cloned());
            before = Some(last);
            if entries.len() < 1000 { break; }
        }
        pending.reverse();
        Ok(pending)
}

async fn rpc_result(client: &reqwest::Client, rpc: &str, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
    for attempt in 0..5 {
        let response = client.post(rpc)
            .json(&serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
            .send().await.map_err(|error| anyhow::anyhow!("{method}: {}", error.without_url()))?;
        if (response.status().as_u16() == 429 || response.status().is_server_error()) && attempt < 4 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * (1 << attempt))).await;
            continue;
        }
        let body: serde_json::Value = response.error_for_status()
            .map_err(|error| anyhow::anyhow!("{method}: {}", error.without_url()))?
            .json().await.context("RPC response is not JSON")?;
        if let Some(error) = body.get("error") { anyhow::bail!("{method}: {error}"); }
        return body.get("result").cloned().context("RPC response is missing result");
    }
    unreachable!()
}

fn program_instructions(
    message: &Message,
    account_keys: &[String],
    program_id: &str,
) -> Vec<(Vec<u8>, Vec<String>)> {
    let mut found = Vec::new();
    for ix in &message.instructions {
        let Some(pid) = account_keys.get(ix.program_id_index as usize) else {
            continue;
        };
        if pid != program_id {
            continue;
        }
        // `accounts` is a byte array where each byte is an account index.
        let accounts = ix
            .accounts
            .iter()
            .filter_map(|idx| account_keys.get(*idx as usize).cloned())
            .collect();
        found.push((ix.data.clone(), accounts));
    }
    found
}

/// Background task entrypoint from `main`.
pub async fn spawn_indexer(config: Config, db: Db, merkle_manager: Arc<RwLock<MerkleManager>>) {
    let indexer = Indexer::new(config, db, merkle_manager);
    if let Err(err) = indexer.run().await {
        warn!(error = %err, "indexer exited");
    }
}

#[cfg(test)]
mod replay_tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use serde_json::{json, Value};

    #[tokio::test]
    async fn paginates_history_and_returns_oldest_first() {
        let app = Router::new().route("/", post(|Json(request): Json<Value>| async move {
            assert_eq!(request["params"][1]["until"], "cursor");
            let entries: Vec<Value> = if request["params"][1]["before"].is_null() {
                (2..1002).rev().map(|i| json!({"signature": format!("s{i}"), "slot": i, "err": null})).collect()
            } else {
                assert_eq!(request["params"][1]["before"], "s2");
                (0..2).rev().map(|i| json!({"signature": format!("s{i}"), "slot": i, "err": null})).collect()
            };
            Json(json!({"jsonrpc": "2.0", "id": 1, "result": entries}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        let history = signature_history(&reqwest::Client::new(), &url, "program", Some("cursor")).await.unwrap();
        assert_eq!(history.len(), 1002);
        assert_eq!(history.first().unwrap()["signature"], "s0");
        assert_eq!(history.last().unwrap()["signature"], "s1001");
        server.abort();
    }

    #[tokio::test]
    async fn rpc_errors_do_not_become_an_empty_history() {
        let app = Router::new().route("/", post(|| async { Json(json!({"error": {"code": -32000, "message": "unavailable"}})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
        assert!(signature_history(&reqwest::Client::new(), &url, "program", None).await.is_err());
        server.abort();
    }
}
