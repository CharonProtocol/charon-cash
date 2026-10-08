//! Lazy on-demand indexer (replaces the Yellowstone gRPC stream).
//!
//! `sync_tree()` is called at the top of tree-state / proof / nullifier /
//! utxo reads and is throttled: a walk that started less than
//! `SYNC_MIN_INTERVAL_MS` ago satisfies the read without another RPC sweep.
//! `sync_tree_forced()` runs from the cron tick and from
//! `index_after_send()` — the relay path itself no longer syncs: the root
//! check reads the chain directly, and the post-send pump indexes in the
//! background via wait_until.
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

/// Post-send indexing, off the relay's critical path: wait for the relayed tx
/// to show a confirmation status (≈400ms apart, bounded), then force syncs
/// until the mirror has actually absorbed the signature. Coalescing is free —
/// sync_tree_forced's lock turns concurrent pumps into a single walk.
///
/// One walk is not enough under load: a busy sync lock turns a forced walk
/// into a silent no-op (Ok-empty from the CAS skip), and a torn write wave can
/// drop a tx's leaves while the cursor still advances — the commitment then
/// 404s forever, the client's change-note resolve never lands, and every lane
/// hop falls back to a full refresh. `has_tx` is the goal condition; retries
/// are what picks a tx up after a coalesced walk indexed only its siblings.
pub async fn index_after_send(state: &AppState, signature: &str) {
    for _ in 0..8 {
        match state.rpc.get_signature_status(signature).await {
            Ok(Some(_)) => break,
            Ok(None) => crate::rpc::sleep_ms(400).await,
            Err(e) => {
                worker::console_warn!("index_after_send: {signature}: {e}");
                break;
            }
        }
    }
    for attempt in 0..3 {
        if let Err(e) = sync_tree_forced(state).await {
            worker::console_warn!("index_after_send sync: {signature}: {e}");
        }
        match state.store.has_tx(signature).await {
            Ok(true) => return,
            Ok(false) => {}
            Err(e) => worker::console_warn!("index_after_send check: {signature}: {e}"),
        }
        if attempt < 2 {
            crate::rpc::sleep_ms(1_000).await;
        }
    }
    worker::console_warn!("index_after_send: {signature}: not indexed after retries");
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

    // Backfill chunking: a full-history pass takes minutes of getTransaction
    // calls, and every Neon statement is one Workers subrequest — the
    // invocation dies at the cap (~50 on the free plan) mid-write-wave,
    // leaving `trees` committed while `tree_levels` lagged (a permanently
    // torn mirror: every proof then folds to the wrong root). Cap each pass
    // to a few txs so the whole pass — backfill included — fits the budget;
    // repeated syncs chew through history in bounded, resumable steps.
    // 6 is the throughput floor, not just a safety cap: an 8-lane payroll
    // run relays ~1 tx/s and each lane's next input note stays unspendable
    // until its tx is indexed — a 3-tx pass can't hold that pace, the mirror
    // lag balloons, and lanes starve in bursts (field-measured: 406s wall
    // with 2.2 effective lanes out of 8). 1 sigs fetch + 6×(1 getTransaction
    // + 5 stmts) ≈ 37 subrequests, inside the cap with headroom.
    const BACKFILL_CHUNK: usize = 6;
    let chunk_complete = pending.len() <= BACKFILL_CHUNK;
    if !chunk_complete {
        pending.truncate(BACKFILL_CHUNK);
    }
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
    let mut last_processed: Option<SigInfo> = None;
    let mut stop = false;
    for sig in &pending {
        if state.store.has_tx(&sig.signature).await? {
            last_processed = Some(sig.clone());
            continue;
        }
        let tx = match state.rpc.get_transaction(&sig.signature).await {
            Ok(tx) => tx,
            Err(_) => {
                crate::rpc::sleep_ms(1500).await;
                match state.rpc.get_transaction(&sig.signature).await {
                    Ok(tx) => tx,
                    Err(e) => {
                        worker::console_warn!("sync: {}: {}", sig.signature, e);
                        stop = true;
                        break;
                    }
                }
            }
        };
        // A null here is devnet index lag, not a missing tx: defer it to the
        // next pass instead of skipping — a skipped tx shifts every later
        // leaf position and permanently diverges the mirror from the chain.
        let Some(tx) = tx else {
            worker::console_warn!("sync: {} not indexed yet, deferring", sig.signature);
            stop = true;
            break;
        };
        if tx.meta.as_ref().map(|m| m.err.is_none()).unwrap_or(false) {
            if let Err(e) = process_tx(state, &sig.signature, &tx).await {
                worker::console_warn!("sync: {}: {}", sig.signature, e);
                stop = true;
                break;
            }
            new_txs += 1;
        }
        last_processed = Some(sig.clone());
    }

    // Advance the cursor only through what this pass actually covered. A
    // stopped pass re-fetches the interrupted tx next time instead of
    // skipping past it; has_tx makes the already-done ones cheap.
    let cursor_target = if stop {
        last_processed
    } else if chunk_complete {
        all.first().cloned()
    } else {
        pending.last().or(all.last()).cloned()
    };
    if let Some(newest) = cursor_target {
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
/// merkle append — five packed statements (D1 used to do this as ONE atomic
/// batch; the Neon HTTP driver has no multi-statement transaction, so the
/// wave is ordered + reprocessable instead: utxos/nullifiers first, then
/// tree_levels, then the `trees` row every proof folds against, and
/// `indexed_txs` ABSOLUTELY LAST as the "fully applied" marker. A wave cut
/// by the subrequest budget before that marker is safely re-run: re-appending
/// the same leaves at the same positions is deterministic, and every row
/// write is ON CONFLICT-idempotent).
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

    // If a previous pass applied this tx's leaves (next_index already moved
    // past them) but died before indexed_txs, re-appending would corrupt the
    // mirror — skip the append and just complete the remaining rows.
    let first_leaf_hex = hex::encode(leaves[0]);
    let applied_at = store
        .commitment_leaf_index(tree_key, &first_leaf_hex)
        .await?;
    let mut start_index = data.next_index;
    if matches!(applied_at, Some(i) if (i as u32) < data.next_index) {
        start_index = applied_at.unwrap() as u32;
    } else {
        merkle::append_leaves(&mut data, &leaves)?;
    }

    let mut stmts = Vec::new();
    {
        let mut sql = String::from(
            "INSERT INTO utxos (tree_key, leaf_index, commitment_hex, encrypted_output_hex, \
             signature, slot, ext_amount, fee) VALUES ",
        );
        let mut params: Vec<crate::store::V> = Vec::with_capacity(leaves.len() * 8);
        for (i, (leaf, enc)) in leaves.iter().zip(&encs).enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            let b = i * 8 + 1;
            let places: Vec<String> = (0..8).map(|k| format!("${}", b + k)).collect();
            sql.push_str(&format!("({})", places.join(", ")));
            params.extend_from_slice(&[
                s(tree_key),
                n(start_index as i64 + i as i64),
                s(hex::encode(leaf)),
                s(hex::encode(enc)),
                s(signature),
                n(slot as i64),
                n(decoded.ext_amount),
                n(decoded.fee as i64),
            ]);
        }
        sql.push_str(" ON CONFLICT (tree_key, leaf_index) DO NOTHING");
        stmts.push(crate::store::stmt(&sql, params));
    }
    {
        let spent: Vec<&[u8; 32]> = decoded
            .input_nullifiers
            .iter()
            .filter(|nf| **nf != [0u8; 32])
            .collect();
        if !spent.is_empty() {
            let mut sql =
                String::from("INSERT INTO nullifiers (nullifier_hex, tree_key, signature, slot) VALUES ");
            let mut params: Vec<crate::store::V> = Vec::with_capacity(spent.len() * 4);
            for (i, nullifier) in spent.iter().enumerate() {
                if i > 0 {
                    sql.push_str(", ");
                }
                let b = i * 4 + 1;
                let places: Vec<String> = (0..4).map(|k| format!("${}", b + k)).collect();
                sql.push_str(&format!("({})", places.join(", ")));
                params.extend_from_slice(&[
                    s(hex::encode(nullifier)),
                    s(tree_key),
                    s(signature),
                    n(slot as i64),
                ]);
            }
            sql.push_str(" ON CONFLICT (nullifier_hex) DO NOTHING");
            stmts.push(crate::store::stmt(&sql, params));
        }
    }
    {
        // All level blobs in ONE statement — a per-level loop is 27
        // subrequests and that alone blew the invocation cap mid-wave.
        let mut sql =
            String::from("INSERT INTO tree_levels (tree_key, level, nodes_hex) VALUES ");
        let mut params: Vec<crate::store::V> = vec![s(tree_key)];
        for level in 0..=crate::accounts::MERKLE_TREE_HEIGHT {
            if data.levels[level].is_empty() {
                continue;
            }
            if params.len() > 1 {
                sql.push_str(", ");
            }
            let b = params.len() + 1;
            sql.push_str(&format!("($1, ${b}, ${})", b + 1));
            params.push(n(level as i64));
            params.push(s(merkle::level_row(&data, level)));
        }
        if params.len() > 1 {
            sql.push_str(
                " ON CONFLICT (tree_key, level) DO UPDATE SET nodes_hex = excluded.nodes_hex",
            );
            stmts.push(crate::store::stmt(&sql, params));
        }
    }
    let (next_index, root_index, history_hex) = merkle::trees_upsert_values(&data);
    stmts.push(crate::store::stmt(
        "INSERT INTO trees (tree_key, next_index, root_index, root_history_hex) \
         VALUES ($1, $2, $3, $4) ON CONFLICT (tree_key) DO UPDATE SET \
         next_index = excluded.next_index, root_index = excluded.root_index, \
         root_history_hex = excluded.root_history_hex",
        vec![s(tree_key), n(next_index), n(root_index), s(history_hex)],
    ));
    let kind_str = match decoded.kind {
        TransactKind::Sol => "sol",
        TransactKind::Spl => "spl",
    };
    stmts.push(crate::store::stmt(
        "INSERT INTO indexed_txs (signature, slot, tree_key, kind) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (signature) DO NOTHING",
        vec![s(signature), n(slot as i64), s(tree_key), s(kind_str)],
    ));

    store.run_batch(stmts).await
}
