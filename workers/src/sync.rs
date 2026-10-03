//! Lazy on-demand indexer (replaces the Yellowstone gRPC stream).
//!
//! `sync_tree()` is called at the top of tree-state / proof / nullifier /
//! utxo reads and is throttled: a walk that started less than
//! `SYNC_MIN_INTERVAL_MS` ago satisfies the read without another RPC sweep.
//! The relayer calls `sync_tree_forced()` (pre-submit and after every
//! confirmed send) so freshly landed txs are always indexed before the
//! client's next read.
//!
//! The walk is incremental: signatures are fetched newest→oldest until the
//! cursor signature appears (or the page runs out), only the signatures
//! newer than the cursor are processed (oldest→newest, matching on-chain
//! leaf order), and the cursor is written once at the end. Duplicate work is
//! impossible: `indexed_txs` dedups signatures and leaf assignment is
//! serialized by the `sync_lock` CAS row.

use std::sync::atomic::Ordering;

use crate::decode::decode_transact_ix;
use crate::merkle::{self};
use crate::rpc::{Rpc, SigInfo, TxJson};
use crate::solana::b58;
use crate::solana::pubkey::Pubkey;
use crate::state::AppState;
use crate::store::{n, s};
use crate::types::TransactKind;

pub struct SyncReport {
    pub new_txs: usize,
    pub walked: usize,
}

pub fn now_ms() -> i64 {
    js_sys::Date::now() as i64
}

const SYNC_MIN_INTERVAL_MS: i64 = 2_000;

pub async fn sync_tree(state: &AppState) -> Result<SyncReport, String> {
    let now = now_ms();
    if now - state.last_sync_ms.load(Ordering::Relaxed) < SYNC_MIN_INTERVAL_MS {
        return Ok(SyncReport { new_txs: 0, walked: 0 });
    }
    sync_tree_forced(state).await
}

pub async fn sync_tree_forced(state: &AppState) -> Result<SyncReport, String> {
    state.last_sync_ms.store(now_ms(), Ordering::Relaxed);
    let token = format!("sync-{}", now_ms());
    if !state.store.try_acquire_lock(&token, now_ms()).await? {
        return Ok(SyncReport { new_txs: 0, walked: 0 });
    }
    let result = sync_locked(state).await;
    state.store.release_lock(&token).await?;
    result
}

async fn sync_locked(state: &AppState) -> Result<SyncReport, String> {
    let (cursor, _) = state.store.get_cursor().await?;
    let mut until: Option<String> = cursor.clone();

    // Collect signatures newer than the cursor (newest first, paged via `before`).
    let mut all: Vec<SigInfo> = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let fetched = state
            .rpc
            .get_signatures_for_address(&state.program_id, before.as_deref(), until.as_deref())
            .await;
        let page = match fetched {
            Ok(page) => page,
            Err(e) if until.is_some() => {
                until = None;
                state
                    .rpc
                    .get_signatures_for_address(&state.program_id, before.as_deref(), None)
                    .await
                    .map_err(|_| e)?
            }
            Err(e) => return Err(e),
        };
        let n = page.len();
        let oldest = page.last().map(|s| s.signature.clone());
        let hit_cursor = cursor
            .as_ref()
            .map(|c| page.iter().any(|s| &s.signature == c))
            .unwrap_or(false);
        all.extend(page);
        if n < 1000 || all.len() >= 40_000 || hit_cursor {
            break;
        }
        before = oldest;
    }

    let pending_end = cursor
        .as_ref()
        .and_then(|c| all.iter().position(|s| &s.signature == c))
        .unwrap_or(all.len());
    if pending_end == 0 {
        return Ok(SyncReport { new_txs: 0, walked: all.len() });
    }

    // Process oldest → newest so leaf indexes follow on-chain order. The
    // signature feed only guarantees slot granularity, so transactions that
    // land in the same slot are re-ordered by their position in that block:
    // the program assigns leaf indexes in execution order.
    let mut pending: Vec<SigInfo> = all[..pending_end].to_vec();
    pending.reverse();
    pending.sort_by_key(|s| s.slot);
    let mut i = 0;
    while i < pending.len() {
        let mut j = i + 1;
        while j < pending.len() && pending[j].slot == pending[i].slot {
            j += 1;
        }
        if j - i > 1 {
            let slot = pending[i].slot;
            if let Ok(order) = state.rpc.get_block_signatures(slot).await {
                pending[i..j].sort_by_key(|s| {
                    order.iter().position(|x| *x == s.signature).unwrap_or(usize::MAX)
                });
            }
        }
        i = j;
    }

    let mut new_txs = 0usize;
    for sig in &pending {
        if state.store.has_tx(&sig.signature).await? {
            continue;
        }
        let tx = match state.rpc.get_transaction(&sig.signature).await {
            Ok(tx) => tx,
            Err(_) => {
                crate::rpc::sleep_ms(1500).await;
                state.rpc.get_transaction(&sig.signature).await?
            }
        };
        if let Some(tx) = tx {
            let ok = tx.meta.as_ref().map(|m| m.err.is_none()).unwrap_or(false);
            if ok {
                if let Err(e) = process_tx(state, &sig.signature, &tx).await {
                    worker::console_warn!("sync: {}: {}", sig.signature, e);
                } else {
                    new_txs += 1;
                }
            }
        }
    }

    if let Some(newest) = all.first() {
        state.store.set_cursor(&newest.signature, newest.slot).await?;
    }

    Ok(SyncReport { new_txs, walked: all.len() })
}

async fn process_tx(state: &AppState, signature: &str, tx: &TxJson) -> Result<(), String> {
    let mut keys: Vec<Pubkey> = tx
        .transaction
        .message
        .account_keys
        .iter()
        .filter_map(|s| Pubkey::parse(s))
        .collect();
    if let Some(meta) = &tx.meta {
        if let Some(la) = &meta.loaded_addresses {
            for k in la.writable.iter().chain(la.readonly.iter()) {
                if let Some(p) = Pubkey::parse(k) {
                    keys.push(p);
                }
            }
        }
    }

    for ix in &tx.transaction.message.instructions {
        let Some(program) = keys.get(ix.program_id_index as usize) else { continue };
        if *program != state.program_id {
            continue;
        }
        let Some(data) = b58::decode(&ix.data) else { continue };
        let Ok(decoded) = decode_transact_ix(&data) else { continue };
        let accounts: Vec<Pubkey> = ix
            .accounts
            .iter()
            .filter_map(|i| keys.get(*i as usize).copied())
            .collect();
        let tree_key = match decoded.kind {
            TransactKind::Sol => "sol".to_string(),
            TransactKind::Spl => accounts
                .get(7)
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown_mint".to_string()),
        };
        insert_transact(state, signature, tx.slot, &tree_key, decoded).await?;
        return Ok(());
    }
    Ok(())
}

/// Insert a decoded transact: 2 utxo rows, nullifiers, the tx row, and the
/// merkle append — all in one D1 batch (atomic).
pub async fn insert_transact(
    state: &AppState,
    signature: &str,
    slot: u64,
    tree_key: &str,
    decoded: crate::types::DecodedTransact,
) -> Result<(), String> {
    let store = &state.store;
    let mut data = merkle::load_tree(store, tree_key).await?;

    let mut leaves: Vec<[u8; 32]> = Vec::with_capacity(2);
    let mut encs: Vec<Vec<u8>> = Vec::with_capacity(2);
    for (commitment, encrypted) in decoded
        .output_commitments
        .iter()
        .zip([&decoded.encrypted_output1, &decoded.encrypted_output2])
    {
        leaves.push(*commitment);
        encs.push(encrypted.clone());
    }
    let start_index = data.next_index;
    merkle::append_leaves(&mut data, &leaves)?;

    let mut stmts = Vec::new();
    for (i, (leaf, enc)) in leaves.iter().zip(&encs).enumerate() {
        stmts.push(crate::store::stmt(
            "INSERT INTO utxos (tree_key, leaf_index, commitment_hex, encrypted_output_hex, \
             signature, slot, ext_amount, fee) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (tree_key, leaf_index) DO NOTHING",
            vec![
                s(tree_key),
                n(start_index as i64 + i as i64),
                s(hex::encode(leaf)),
                s(hex::encode(enc)),
                s(signature),
                n(slot as i64),
                n(decoded.ext_amount),
                n(decoded.fee as i64),
            ],
        ));
    }
    for nullifier in &decoded.input_nullifiers {
        if *nullifier == [0u8; 32] {
            continue;
        }
        stmts.push(crate::store::stmt(
            "INSERT INTO nullifiers (nullifier_hex, tree_key, signature, slot) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (nullifier_hex) DO NOTHING",
            vec![s(hex::encode(nullifier)), s(tree_key), s(signature), n(slot as i64)],
        ));
    }
    let kind_str = match decoded.kind {
        TransactKind::Sol => "sol",
        TransactKind::Spl => "spl",
    };
    stmts.push(crate::store::stmt(
        "INSERT INTO indexed_txs (signature, slot, tree_key, kind) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (signature) DO NOTHING",
        vec![s(signature), n(slot as i64), s(tree_key), s(kind_str)],
    ));
    let (next_index, root_index, history_hex) = merkle::trees_upsert_values(&data);
    stmts.push(crate::store::stmt(
        "INSERT INTO trees (tree_key, next_index, root_index, root_history_hex) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (tree_key) DO UPDATE SET \
         next_index = excluded.next_index, root_index = excluded.root_index, \
         root_history_hex = excluded.root_history_hex",
        vec![s(tree_key), n(next_index), n(root_index), s(history_hex)],
    ));
    for level in 0..=crate::accounts::MERKLE_TREE_HEIGHT {
        if data.levels[level].is_empty() {
            continue;
        }
        stmts.push(crate::store::stmt(
            "INSERT INTO tree_levels (tree_key, level, nodes_hex) VALUES ($1, $2, $3) \
             ON CONFLICT (tree_key, level) DO UPDATE SET nodes_hex = excluded.nodes_hex",
            vec![s(tree_key), n(level as i64), s(merkle::level_row(&data, level))],
        ));
    }

    store.run_batch(stmts).await
}
