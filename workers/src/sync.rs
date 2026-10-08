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

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use crate::decode::decode_transact_ix;
use crate::merkle::{self};
use crate::rpc::{SigInfo, TxJson};
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

/// Inline post-send indexing on the relay response path, bounded by wall
/// clock. The withdrawal's change note stays unspendable until the mirror
/// absorbs this tx — every downstream correctness read (commitment lookup,
/// nullifier adjudication, next lane's proof) consults the mirror — so the
/// relay waits instead of answering with a trailing mirror. The walks here
/// are the same chain-ordered passes as the background pump, so leaf order
/// stays authoritative; concurrent relays coalesce on the sync CAS lock and a
/// coalesced (no-op) walk just costs one retry round. Returns whether the tx
/// actually landed; the caller queues it as fallback either way.
pub async fn index_now(state: &AppState, signature: &str) -> bool {
    let deadline = now_ms() + 7_000;
    let mut round = 0;
    while now_ms() < deadline && round < 10 {
        if let Err(e) = sync_tree_forced(state).await {
            worker::console_warn!("index_now sync: {signature}: {e}");
        }
        match state.store.has_tx(signature).await {
            Ok(true) => return true,
            Ok(false) => {}
            Err(e) => worker::console_warn!("index_now check: {signature}: {e}"),
        }
        round += 1;
        crate::rpc::sleep_ms(350).await;
    }
    false
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
    // to a bounded, resumable step. 12 is sized by the pass budget: 1 sigs
    // fetch + 12 getTransactions + ~5 write statements (the whole pass's
    // tree state, utxos, nullifiers and markers pack into batched
    // statements — see flush_pass) ≈ 18 subrequests, and ~4 tx/s of
    // sustained supply, ~4x what 16-lane runs demand.
    const BACKFILL_CHUNK: usize = 12;
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
    // Phase 1 — fetch, decode, reserve leaf positions in memory. Nothing is
    // written until planning completes: a deferred getTransaction stops the
    // pass BEFORE any write, so the mirror is never left mid-wave.
    let mut trees: HashMap<String, merkle::TreeData> = HashMap::new();
    let mut plans: Vec<PlannedTx> = Vec::new();
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
        match plan_tx(state, &mut trees, &sig.signature, &tx).await {
            Ok(Some(plan)) => {
                plans.push(plan);
                last_processed = Some(sig.clone());
            }
            Ok(None) => last_processed = Some(sig.clone()),
            Err(e) => {
                worker::console_warn!("sync: {}: {}", sig.signature, e);
                stop = true;
                break;
            }
        }
    }

    // Phase 2 — one batched write for the whole pass. Plans already carry
    // their leaf positions; the flush packs every row into ~5 statements.
    if !plans.is_empty() {
        match flush_pass(state, &trees, &plans).await {
            Ok(()) => new_txs = plans.len(),
            Err(e) => {
                worker::console_warn!("sync flush: {e}");
                stop = true;
                // The failed pass wrote nothing (run_batch is the first and
                // only write point) — hold the cursor before the pass so the
                // whole chunk re-plans next time.
                last_processed = None;
                for sig in pending.iter() {
                    if sig.signature == plans[0].signature {
                        break;
                    }
                    last_processed = Some(sig.clone());
                }
            }
        }
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

struct PlannedTx {
    signature: String,
    slot: u64,
    tree_key: String,
    decoded: crate::types::DecodedTransact,
    start_index: u32,
}

/// Decode a program transact out of a fetched tx and reserve its leaf
/// positions in the pass's in-memory tree. Idempotent under partial passes:
/// if this tx's first leaf is already in the tree (a previous pass wrote the
/// tree but died before its rows), the existing position is adopted instead
/// of appending a duplicate.
async fn plan_tx(
    state: &AppState,
    trees: &mut HashMap<String, merkle::TreeData>,
    signature: &str,
    tx: &TxJson,
) -> Result<Option<PlannedTx>, String> {
    if !tx.meta.as_ref().map(|m| m.err.is_none()).unwrap_or(false) {
        return Ok(None);
    }
    let Some((tree_key, decoded, slot)) = extract_decoded(state, tx) else {
        return Ok(None);
    };
    if !trees.contains_key(&tree_key) {
        let loaded = merkle::load_tree(&state.store, &tree_key).await?;
        trees.insert(tree_key.clone(), loaded);
    }
    let data = trees.get_mut(&tree_key).expect("tree just inserted");
    let leaves: Vec<[u8; 32]> = decoded.output_commitments.to_vec();
    let start_index = match find_leaf_index(data, &leaves[0]) {
        Some(p) => p,
        None => {
            let next = data.next_index;
            merkle::append_leaves(data, &leaves)?;
            next
        }
    };
    Ok(Some(PlannedTx {
        signature: signature.to_string(),
        slot,
        tree_key,
        decoded,
        start_index,
    }))
}

/// Where does this commitment already sit in the tree's leaf level, scanning
/// newest-first over the trailing window a partial pass could have written?
/// Commitments include per-note randomness, so equality is exact.
fn find_leaf_index(data: &merkle::TreeData, leaf: &[u8; 32]) -> Option<u32> {
    let level = data.levels.first()?;
    let start = (data.next_index as usize).min(level.len());
    let lo = start.saturating_sub(256);
    (lo..start)
        .rev()
        .find(|&i| &level[i] == leaf)
        .map(|i| i as u32)
}

/// Pull the (single) program transact out of a fetched tx: decode the ix,
/// resolve the pool's tree_key from its accounts. Shared by the indexer and
/// the admin heal route.
pub(crate) fn extract_decoded(
    state: &AppState,
    tx: &TxJson,
) -> Option<(String, crate::types::DecodedTransact, u64)> {
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
        let program = keys.get(ix.program_id_index as usize)?;
        if *program != state.program_id {
            continue;
        }
        let data = b58::decode(&ix.data)?;
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
        return Some((tree_key, decoded, tx.slot));
    }
    None
}

/// Write a planned pass. Order carries the recovery invariant: tree state
/// FIRST (levels + meta per pool — the authoritative leaf positions every
/// proof folds against), then utxo rows, then nullifiers, then indexed_txs
/// ABSOLUTELY LAST as the completion marker. A pass cut anywhere re-runs
/// wholly and safely: plan_tx adopts the already-written tree positions and
/// every row upsert is conflict-idempotent.
///
/// Statement budget for a 12-tx single-pool pass: 2 (tree) + 3 (rows) = 5 —
/// plus the fetch phase's 1 signatures + 12 getTransaction, ~18 total,
/// comfortably inside the ~50-subrequest invocation cap. The old per-tx
/// wave burned 5 statements PER tx, which both capped supply near
/// 1 tx/s and left the mirror torn for most of each pass (the torn-read
/// guard then failed real rows).
async fn flush_pass(
    state: &AppState,
    trees: &HashMap<String, merkle::TreeData>,
    plans: &[PlannedTx],
) -> Result<(), String> {
    let store = &state.store;
    let mut stmts = Vec::new();

    for (tree_key, data) in trees {
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
            params.push(s(merkle::level_row(data, level)));
        }
        if params.len() > 1 {
            sql.push_str(
                " ON CONFLICT (tree_key, level) DO UPDATE SET nodes_hex = excluded.nodes_hex",
            );
            stmts.push(crate::store::stmt(&sql, params));
        }
        let (next_index, root_index, history_hex) = merkle::trees_upsert_values(data);
        stmts.push(crate::store::stmt(
            "INSERT INTO trees (tree_key, next_index, root_index, root_history_hex) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (tree_key) DO UPDATE SET \
             next_index = excluded.next_index, root_index = excluded.root_index, \
             root_history_hex = excluded.root_history_hex",
            vec![s(tree_key), n(next_index), n(root_index), s(history_hex)],
        ));
    }

    {
        let mut sql = String::from(
            "INSERT INTO utxos (tree_key, leaf_index, commitment_hex, encrypted_output_hex, \
             signature, slot, ext_amount, fee) VALUES ",
        );
        let mut params: Vec<crate::store::V> = Vec::new();
        for plan in plans {
            let encs = [&plan.decoded.encrypted_output1, &plan.decoded.encrypted_output2];
            for (i, (leaf, enc)) in plan.decoded.output_commitments.iter().zip(encs).enumerate() {
                if !params.is_empty() {
                    sql.push_str(", ");
                }
                let b = params.len() + 1;
                let places: Vec<String> = (0..8).map(|k| format!("${}", b + k)).collect();
                sql.push_str(&format!("({})", places.join(", ")));
                params.extend_from_slice(&[
                    s(&plan.tree_key),
                    n(plan.start_index as i64 + i as i64),
                    s(hex::encode(leaf)),
                    s(hex::encode(enc)),
                    s(&plan.signature),
                    n(plan.slot as i64),
                    n(plan.decoded.ext_amount),
                    n(plan.decoded.fee as i64),
                ]);
            }
        }
        sql.push_str(" ON CONFLICT (tree_key, leaf_index) DO NOTHING");
        stmts.push(crate::store::stmt(&sql, params));
    }
    {
        let mut sql =
            String::from("INSERT INTO nullifiers (nullifier_hex, tree_key, signature, slot) VALUES ");
        let mut params: Vec<crate::store::V> = Vec::new();
        for plan in plans {
            for nf in plan.decoded.input_nullifiers.iter().filter(|nf| **nf != [0u8; 32]) {
                if !params.is_empty() {
                    sql.push_str(", ");
                }
                let b = params.len() + 1;
                let places: Vec<String> = (0..4).map(|k| format!("${}", b + k)).collect();
                sql.push_str(&format!("({})", places.join(", ")));
                params.extend_from_slice(&[
                    s(hex::encode(nf)),
                    s(&plan.tree_key),
                    s(&plan.signature),
                    n(plan.slot as i64),
                ]);
            }
        }
        sql.push_str(" ON CONFLICT (nullifier_hex) DO NOTHING");
        stmts.push(crate::store::stmt(&sql, params));
    }
    {
        let mut sql = String::from(
            "INSERT INTO indexed_txs (signature, slot, tree_key, kind) VALUES ",
        );
        let mut params: Vec<crate::store::V> = Vec::new();
        for plan in plans {
            if !params.is_empty() {
                sql.push_str(", ");
            }
            let kind_str = match plan.decoded.kind {
                TransactKind::Sol => "sol",
                TransactKind::Spl => "spl",
            };
            let b = params.len() + 1;
            let places: Vec<String> = (0..4).map(|k| format!("${}", b + k)).collect();
            sql.push_str(&format!("({})", places.join(", ")));
            params.extend_from_slice(&[
                s(&plan.signature),
                n(plan.slot as i64),
                s(&plan.tree_key),
                s(kind_str),
            ]);
        }
        sql.push_str(" ON CONFLICT (signature) DO NOTHING");
        stmts.push(crate::store::stmt(&sql, params));
    }

    store.run_batch(stmts).await
}

/// Repair a mirror with holes. A torn write wave can commit tree state while
/// dropping a tx's utxo rows; the leaf VALUES survive in tree_levels level 0,
/// so the rows are rebuildable from the chain without touching the tree.
/// Scans the newest `limit` indexed txs, finds signatures whose utxo rows are
/// missing or partial, refetches and rewrites them. Bounded per invocation by
/// the subrequest cap (~1 + 1 + 12×(1 getTransaction + 1 insert) ≈ 26);
/// `pending` reports holes left for the next call.
pub async fn heal_holes(
    state: &AppState,
    limit: usize,
) -> Result<serde_json::Value, String> {
    let store = &state.store;
    let scanned = store
        .db
        .query(
            "SELECT signature, slot, tree_key FROM indexed_txs ORDER BY slot DESC LIMIT $1",
            &[n(limit as i64)],
        )
        .await?;
    let mut sigs: Vec<String> = Vec::new();
    for row in &scanned {
        let sig = crate::store::str_at(row, "signature");
        if !sig.is_empty() {
            sigs.push(sig);
        }
    }
    // One grouped count per signature batch keeps this to a single statement.
    let mut counts: HashMap<String, i64> = HashMap::new();
    if !sigs.is_empty() {
        let placeholders: Vec<String> = (1..=sigs.len()).map(|i| format!("${i}")).collect();
        let sql = format!(
            "SELECT signature, COUNT(*)::int AS c FROM utxos WHERE signature IN ({}) GROUP BY signature",
            placeholders.join(", ")
        );
        let params: Vec<crate::store::V> = sigs.iter().map(|sig| s(sig)).collect();
        for row in store.db.query(&sql, &params).await? {
            let sig = crate::store::str_at(&row, "signature");
            if !sig.is_empty() {
                counts.insert(sig, crate::store::i64_at(&row, "c"));
            }
        }
    }

    let mut repaired: Vec<serde_json::Value> = Vec::new();
    let mut pending = 0usize;
    for sig in &sigs {
        let have = counts.get(sig).copied().unwrap_or(0);
        if have >= 2 {
            continue;
        }
        if repaired.len() >= 12 {
            pending += 1;
            continue;
        }
        let Some(tx) = state
            .rpc
            .get_transaction(sig)
            .await
            .map_err(|e| format!("heal get_transaction {sig}: {e}"))?
        else {
            repaired.push(serde_json::json!({
                "signature": sig, "repaired": false, "reason": "tx not on rpc yet",
            }));
            continue;
        };
        let Some((tree_key, decoded, slot)) = extract_decoded(state, &tx) else {
            repaired.push(serde_json::json!({
                "signature": sig, "repaired": false, "reason": "no program transact decoded",
            }));
            continue;
        };
        let data = merkle::load_tree(store, &tree_key).await?;
        let encs = [&decoded.encrypted_output1, &decoded.encrypted_output2];
        let mut leaves_sql = String::from(
            "INSERT INTO utxos (tree_key, leaf_index, commitment_hex, encrypted_output_hex, \
             signature, slot, ext_amount, fee) VALUES ",
        );
        let mut params: Vec<crate::store::V> = Vec::new();
        let mut leaf_indexes: Vec<u32> = Vec::new();
        let mut missing_leaf = false;
        for (i, leaf) in decoded.output_commitments.iter().enumerate() {
            let idx = find_leaf_index_full(&data, leaf);
            let Some(idx) = idx else {
                missing_leaf = true;
                break;
            };
            let b = params.len() + 1;
            if b > 1 {
                leaves_sql.push_str(", ");
            }
            let places: Vec<String> = (0..8).map(|k| format!("${}", b + k)).collect();
            leaves_sql.push_str(&format!("({})", places.join(", ")));
            params.extend_from_slice(&[
                s(&tree_key),
                n(idx as i64),
                s(hex::encode(leaf)),
                s(hex::encode(encs[i])),
                s(sig),
                n(slot as i64),
                n(decoded.ext_amount),
                n(decoded.fee as i64),
            ]);
            leaf_indexes.push(idx);
        }
        if missing_leaf {
            repaired.push(serde_json::json!({
                "signature": sig, "repaired": false,
                "reason": "commitment absent from mirror leaf level (tree state torn, not just rows)",
            }));
            continue;
        }
        let mut stmts = vec![crate::store::stmt(&leaves_sql, params)];
        let mut nf_sql =
            String::from("INSERT INTO nullifiers (nullifier_hex, tree_key, signature, slot) VALUES ");
        let mut nf_params: Vec<crate::store::V> = Vec::new();
        for nf in decoded.input_nullifiers.iter().filter(|nf| **nf != [0u8; 32]) {
            if !nf_params.is_empty() {
                nf_sql.push_str(", ");
            }
            let b = nf_params.len() + 1;
            let places: Vec<String> = (0..4).map(|k| format!("${}", b + k)).collect();
            nf_sql.push_str(&format!("({})", places.join(", ")));
            nf_params.extend_from_slice(&[
                s(hex::encode(nf)),
                s(&tree_key),
                s(sig),
                n(slot as i64),
            ]);
        }
        nf_sql.push_str(" ON CONFLICT (nullifier_hex) DO NOTHING");
        stmts.push(crate::store::stmt(&nf_sql, nf_params));
        store.run_batch(stmts).await.map_err(|e| format!("heal write {sig}: {e}"))?;
        repaired.push(serde_json::json!({
            "signature": sig, "repaired": true, "tree_key": tree_key,
            "leaf_indexes": leaf_indexes,
        }));
    }

    Ok(serde_json::json!({
        "scanned": sigs.len(),
        "repaired": repaired,
        "pending": pending,
    }))
}

/// Full newest-first scan of the leaf level — a hole can sit anywhere in the
/// tree, not just the trailing window the indexer's redo path scans.
fn find_leaf_index_full(data: &merkle::TreeData, leaf: &[u8; 32]) -> Option<u32> {
    let level = data.levels.first()?;
    let start = (data.next_index as usize).min(level.len());
    (0..start)
        .rev()
        .find(|&i| &level[i] == leaf)
        .map(|i| i as u32)
}
