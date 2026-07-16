//! Yellowstone gRPC stream: subscribe to program txs → decode → persist via `Db`.
//!
//! Replaces RPC `getSignaturesForAddress` polling with a live Geyser subscription filtered to our
//! Pinocchio program id. On startup it resumes from the last indexed slot, and it takes each
//! leaf's index from the program's commitment event rather than a local counter — so a missed
//! transaction can never silently renumber every later leaf.

use std::collections::HashMap;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use tracing::{debug, info, warn};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient, ReconnectConfig};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeRequestPing, SubscribeUpdateTransactionInfo,
};
use yellowstone_grpc_proto::solana::storage::confirmed_block::{Message, TransactionStatusMeta};

use crate::config::Config;
use crate::db::Db;

use super::decode::{decode_transact_ix, parse_commitment_events};
use super::types::{IndexedNullifier, IndexedTransact, IndexedUtxo, TransactKind, SOL_TREE_KEY};

pub struct Indexer {
    config: Config,
    db: Db,
}

impl Indexer {
    pub fn new(config: Config, db: Db) -> Self {
        Self { config, db }
    }

    /// Connect to Yellowstone and index forever (reconnect on stream errors).
    pub async fn run(self) -> Result<()> {
        info!(
            program_id = %self.config.program_id,
            grpc = %self.config.yellowstone_grpc_url,
            "indexer starting (yellowstone gRPC)"
        );

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

        if let Some(token) = &self.config.yellowstone_x_token {
            builder = builder
                .x_token(Some(token.clone()))
                .context("invalid YELLOWSTONE_X_TOKEN")?;
        }

        let mut client = builder
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .context("tls config")?
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

        // Resume from where we left off. Without this a restart silently begins at "now" and every
        // transaction produced while we were down is lost forever (there is no backfill).
        let from_slot = self.db.resume_from_slot().await.unwrap_or(None);

        subscribe_tx
            .send(SubscribeRequest {
                transactions: HashMap::from([("privacy_cash".to_string(), filter)]),
                commitment: Some(CommitmentLevel::Confirmed as i32),
                from_slot,
                ..Default::default()
            })
            .await
            .context("send subscribe request")?;

        info!(?from_slot, "yellowstone subscription active");

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

        if self.db.has_tx(&signature).await? {
            debug!(%signature, "already indexed");
            return Ok(());
        }

        let transacts = self.build_indexed(slot, &signature, tx_info);

        if transacts.is_empty() {
            // Not a transact (initialize/config) or a failed tx — advance the cursor so a restart
            // doesn't re-scan from here, but persist nothing.
            self.db.set_cursor(&signature, slot).await?;
            return Ok(());
        }

        for indexed in &transacts {
            self.db.insert_transact(indexed).await?;
            info!(
                signature = %signature,
                tree = %indexed.tree_key,
                leaves = indexed.utxos.len(),
                first_leaf = indexed.utxos.first().map(|u| u.leaf_index).unwrap_or(0),
                "indexed transact"
            );
        }

        Ok(())
    }

    /// Decode every `transact` in this transaction, pairing each with its commitment event (which
    /// carries the authoritative leaf index). Returns an empty vec for non-transact / failed txs.
    fn build_indexed(
        &self,
        slot: u64,
        signature: &str,
        tx_info: SubscribeUpdateTransactionInfo,
    ) -> Vec<IndexedTransact> {
        let Some(meta) = &tx_info.meta else {
            return Vec::new();
        };
        if meta.err.is_some() {
            return Vec::new();
        }

        let Some(message) = tx_info
            .transaction
            .as_ref()
            .and_then(|tx| tx.message.as_ref())
        else {
            return Vec::new();
        };

        // Full account-key list: static keys, then ALT-loaded writable, then readonly (v0 order).
        let mut account_keys: Vec<String> = message
            .account_keys
            .iter()
            .map(|k| bs58::encode(k).into_string())
            .collect();
        for key in &meta.loaded_writable_addresses {
            account_keys.push(bs58::encode(key).into_string());
        }
        for key in &meta.loaded_readonly_addresses {
            account_keys.push(bs58::encode(key).into_string());
        }

        let program_id = self.config.program_id.to_string();
        let program_ixs = collect_program_instructions(message, meta, &account_keys, &program_id);
        if program_ixs.is_empty() {
            return Vec::new();
        }

        let events = parse_commitment_events(&meta.log_messages);

        // Each transact emits exactly one event, in the same order. If the counts disagree, the
        // program and indexer are out of sync — refuse to guess indices (which would corrupt the
        // tree) and surface it loudly instead.
        if events.len() != program_ixs.len() {
            warn!(
                %signature,
                transacts = program_ixs.len(),
                events = events.len(),
                "transact/event count mismatch — skipping tx (no reliable leaf index)"
            );
            return Vec::new();
        }

        let mut out = Vec::with_capacity(program_ixs.len());
        for ((ix_data, accounts), event) in program_ixs.into_iter().zip(events) {
            let decoded = match decode_transact_ix(&ix_data) {
                Ok(d) => d,
                Err(err) => {
                    // A program instruction that filtered in but doesn't decode is a real problem
                    // (layout drift?), not something to drop in silence.
                    warn!(%signature, error = %err, "failed to decode a program instruction");
                    continue;
                }
            };

            let tree_key = match decoded.kind {
                TransactKind::Sol => SOL_TREE_KEY.to_string(),
                // TransactSpl account layout: mint is index 7.
                TransactKind::Spl => match accounts.get(7) {
                    Some(mint) => mint.clone(),
                    None => {
                        warn!(%signature, "SPL transact missing mint account; skipping");
                        continue;
                    }
                },
            };

            let base = event.leaf_index;
            let utxos = decoded
                .output_commitments
                .iter()
                .zip([&decoded.encrypted_output1, &decoded.encrypted_output2])
                .enumerate()
                .map(|(i, (commitment, encrypted))| IndexedUtxo {
                    tree_key: tree_key.clone(),
                    leaf_index: base + i as u32,
                    commitment: *commitment,
                    encrypted_output: encrypted.clone(),
                    signature: signature.to_string(),
                    slot,
                    ext_amount: decoded.ext_amount,
                    fee: decoded.fee,
                })
                .collect();

            let nullifiers = decoded
                .input_nullifiers
                .iter()
                .map(|n| IndexedNullifier {
                    tree_key: tree_key.clone(),
                    nullifier: *n,
                    signature: signature.to_string(),
                    slot,
                })
                .collect();

            out.push(IndexedTransact {
                signature: signature.to_string(),
                slot,
                tree_key,
                kind: decoded.kind,
                event_root: event.root,
                utxos,
                nullifiers,
            });
        }

        out
    }
}

/// Every instruction invoking our program, top-level and via CPI, in execution order — so a
/// batched or CPI'd transact is not missed. Returns `(data, resolved account keys)` per ix.
fn collect_program_instructions(
    message: &Message,
    meta: &TransactionStatusMeta,
    account_keys: &[String],
    program_id: &str,
) -> Vec<(Vec<u8>, Vec<String>)> {
    let resolve_accounts = |accounts: &[u8]| -> Vec<String> {
        accounts
            .iter()
            .filter_map(|idx| account_keys.get(*idx as usize).cloned())
            .collect()
    };
    let is_ours = |program_id_index: u32| -> bool {
        account_keys
            .get(program_id_index as usize)
            .map(|pid| pid == program_id)
            .unwrap_or(false)
    };

    let mut out = Vec::new();
    for ix in &message.instructions {
        if is_ours(ix.program_id_index) {
            out.push((ix.data.clone(), resolve_accounts(&ix.accounts)));
        }
    }
    for inner in &meta.inner_instructions {
        for ix in &inner.instructions {
            if is_ours(ix.program_id_index) {
                out.push((ix.data.clone(), resolve_accounts(&ix.accounts)));
            }
        }
    }
    out
}

/// Background task entrypoint from `main`.
pub async fn spawn_indexer(config: Config, db: Db) {
    let indexer = Indexer::new(config, db);
    if let Err(err) = indexer.run().await {
        warn!(error = %err, "indexer exited");
    }
}
