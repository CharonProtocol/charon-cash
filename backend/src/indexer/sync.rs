//! Yellowstone gRPC stream: subscribe to program txs → decode → persist via `Db`.
//!
//! Replaces RPC `getSignaturesForAddress` polling with a live Geyser subscription
//! filtered to our Pinocchio program id.

use std::collections::HashMap;

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use tracing::{debug, info, warn};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient, ReconnectConfig};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeRequestPing, SubscribeUpdateTransactionInfo,
};
use yellowstone_grpc_proto::solana::storage::confirmed_block::Message;

use crate::config::Config;
use crate::db::Db;

use super::decode::decode_transact_ix;
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

        subscribe_tx
            .send(SubscribeRequest {
                transactions: HashMap::from([("privacy_cash".to_string(), filter)]),
                commitment: Some(CommitmentLevel::Confirmed as i32),
                ..Default::default()
            })
            .await
            .context("send subscribe request")?;

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

        if self.db.has_tx(&signature).await? {
            debug!(%signature, "already indexed");
            return Ok(());
        }

        match self.build_indexed(slot, &signature, tx_info).await? {
            Some(indexed) => {
                self.db.insert_transact(&indexed).await?;
                info!(
                    signature = %signature,
                    tree = %indexed.tree_key,
                    leaves = indexed.utxos.len(),
                    "indexed transact"
                );
            }
            None => {
                // Non-transact program ix (initialize, etc.) — still advance cursor.
                self.db.set_cursor(&signature, slot).await?;
            }
        }

        Ok(())
    }

    async fn build_indexed(
        &self,
        slot: u64,
        signature: &str,
        tx_info: SubscribeUpdateTransactionInfo,
    ) -> Result<Option<IndexedTransact>> {
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
        let Some((ix_data, accounts)) =
            extract_program_instruction(message, &account_keys, &program_id)
        else {
            return Ok(None);
        };

        let decoded = match decode_transact_ix(&ix_data) {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        let tree_key = match decoded.kind {
            TransactKind::Sol => SOL_TREE_KEY.to_string(),
            // TransactSpl account layout: mint is index 7.
            TransactKind::Spl => accounts
                .get(7)
                .cloned()
                .unwrap_or_else(|| "unknown_mint".to_string()),
        };

        let start_index = self.db.next_index(&tree_key).await?;
        let mut utxos = Vec::with_capacity(2);
        for (i, (commitment, encrypted)) in decoded
            .output_commitments
            .iter()
            .zip([&decoded.encrypted_output1, &decoded.encrypted_output2])
            .enumerate()
        {
            utxos.push(IndexedUtxo {
                tree_key: tree_key.clone(),
                leaf_index: start_index + i as u32,
                commitment: *commitment,
                encrypted_output: encrypted.clone(),
                signature: signature.to_string(),
                slot,
                ext_amount: decoded.ext_amount,
                fee: decoded.fee,
            });
        }

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

        Ok(Some(IndexedTransact {
            signature: signature.to_string(),
            slot,
            tree_key,
            decoded,
            utxos,
            nullifiers,
        }))
    }
}

fn extract_program_instruction(
    message: &Message,
    account_keys: &[String],
    program_id: &str,
) -> Option<(Vec<u8>, Vec<String>)> {
    for ix in &message.instructions {
        let pid = account_keys.get(ix.program_id_index as usize)?;
        if pid != program_id {
            continue;
        }
        // `accounts` is a byte array where each byte is an account index.
        let accounts = ix
            .accounts
            .iter()
            .filter_map(|idx| account_keys.get(*idx as usize).cloned())
            .collect();
        return Some((ix.data.clone(), accounts));
    }
    None
}

/// Background task entrypoint from `main`.
pub async fn spawn_indexer(config: Config, db: Db) {
    let indexer = Indexer::new(config, db);
    if let Err(err) = indexer.run().await {
        warn!(error = %err, "indexer exited");
    }
}
