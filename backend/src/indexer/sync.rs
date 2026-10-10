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
            Some(IndexedEvent::Transact(mut indexed)) => {
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
                    tree = %indexed.tree_key,
                    "indexed transact"
                );
            }
            Some(IndexedEvent::Swap(swap)) => {
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
                    in_tree = %swap.in_tree_key,
                    out_tree = %swap.out_tree_key,
                    "indexed swap"
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
