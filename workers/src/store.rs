//! D1 data access. All binary values round-trip as hex TEXT.

use serde::Deserialize;
use wasm_bindgen::JsValue;
use worker::{D1Database, D1PreparedStatement};

#[derive(Deserialize)]
pub struct CursorRow {
    pub last_signature: Option<String>,
    pub last_slot: i64,
}

#[derive(Deserialize)]
pub struct TreeRow {
    pub next_index: i64,
    pub root_index: i64,
    pub root_history_hex: String,
}

#[derive(Deserialize)]
pub struct LevelRow {
    pub level: i64,
    pub nodes_hex: String,
}

#[derive(Deserialize)]
pub struct CountRow {
    pub count: i64,
}

#[derive(Deserialize)]
pub struct SigRow {
    pub signature: String,
}

#[derive(Deserialize)]
pub struct UtxoRangeRow {
    pub leaf_index: i64,
    pub commitment_hex: String,
    pub encrypted_output_hex: String,
    pub signature: String,
    pub slot: i64,
}

#[derive(Deserialize)]
pub struct NoteRow {
    pub ciphertext_hex: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct UtxoCheckRow {
    pub tree_key: String,
    pub leaf_index: i64,
    pub commitment_hex: String,
    pub signature: String,
    pub slot: i64,
}

/// A bound parameter: TEXT or INTEGER. JS numbers hold integers exactly up to
/// 2^53, which covers every value we bind (slots, indexes, amounts).
pub enum B {
    S(String),
    N(i64),
}

pub fn s(v: impl Into<String>) -> B {
    B::S(v.into())
}

pub fn n(v: i64) -> B {
    B::N(v)
}

fn to_js(vals: Vec<B>) -> Vec<JsValue> {
    vals.into_iter()
        .map(|v| match v {
            B::S(x) => JsValue::from_str(&x),
            B::N(x) => JsValue::from_f64(x as f64),
        })
        .collect()
}

pub struct Store {
    pub db: D1Database,
}

impl Store {
    pub fn new(db: D1Database) -> Self {
        Store { db }
    }

    pub fn stmt(&self, sql: &str) -> D1PreparedStatement {
        self.db.prepare(sql)
    }

    pub fn bound(&self, sql: &str, vals: Vec<B>) -> Result<D1PreparedStatement, String> {
        let js = to_js(vals);
        self.db.prepare(sql).bind(&js).map_err(|e| format!("bind: {e}"))
    }

    pub async fn get_cursor(&self) -> Result<(Option<String>, u64), String> {
        let row: Option<CursorRow> = self
            .db
            .prepare("SELECT last_signature, last_slot FROM indexer_cursor WHERE id = 1")
            .first(None)
            .await
            .map_err(|e| format!("get_cursor: {e}"))?;
        Ok(row.map(|r| (r.last_signature, r.last_slot as u64)).unwrap_or((None, 0)))
    }

    pub async fn set_cursor(&self, signature: &str, slot: u64) -> Result<(), String> {
        self.bound(
            "UPDATE indexer_cursor SET last_signature = ?1, last_slot = ?2 WHERE id = 1",
            vec![s(signature), n(slot as i64)],
        )?
        .run()
        .await
        .map_err(|e| format!("set_cursor: {e}"))?;
        Ok(())
    }

    pub async fn has_tx(&self, signature: &str) -> Result<bool, String> {
        let row: Option<SigRow> = self
            .bound("SELECT signature FROM indexed_txs WHERE signature = ?1", vec![s(signature)])?
            .first(None)
            .await
            .map_err(|e| format!("has_tx: {e}"))?;
        Ok(row.is_some())
    }

    pub async fn try_acquire_lock(&self, token: &str, now_ms: i64) -> Result<bool, String> {
        let stale_before = now_ms - 30_000;
        let res = self
            .bound(
                "UPDATE sync_lock SET token = ?1, ts = ?2 \
                 WHERE id = 1 AND (token IS NULL OR ts < ?3)",
                vec![s(token), n(now_ms), n(stale_before)],
            )?
            .run()
            .await
            .map_err(|e| format!("lock: {e}"))?;
        Ok(res
            .meta()
            .map_err(|e| format!("lock meta: {e}"))?
            .map(|m| m.changes.unwrap_or(0) > 0)
            .unwrap_or(false))
    }

    pub async fn release_lock(&self, token: &str) -> Result<(), String> {
        self.bound(
            "UPDATE sync_lock SET token = NULL, ts = 0 WHERE id = 1 AND token = ?1",
            vec![s(token)],
        )?
        .run()
        .await
        .map_err(|e| format!("unlock: {e}"))?;
        Ok(())
    }

    pub async fn tree_row(&self, tree_key: &str) -> Result<Option<TreeRow>, String> {
        self.bound(
            "SELECT next_index, root_index, root_history_hex FROM trees WHERE tree_key = ?1",
            vec![s(tree_key)],
        )?
        .first(None)
        .await
        .map_err(|e| format!("tree_row: {e}"))
    }

    pub async fn level_rows(&self, tree_key: &str) -> Result<Vec<LevelRow>, String> {
        let res = self
            .bound(
                "SELECT level, nodes_hex FROM tree_levels WHERE tree_key = ?1",
                vec![s(tree_key)],
            )?
            .all()
            .await
            .map_err(|e| format!("level_rows: {e}"))?;
        res.results::<LevelRow>().map_err(|e| format!("level_rows: {e}"))
    }

    pub async fn leaf_count(&self, tree_key: &str) -> Result<i64, String> {
        let row: Option<CountRow> = self
            .bound(
                "SELECT COUNT(*) AS count FROM utxos WHERE tree_key = ?1",
                vec![s(tree_key)],
            )?
            .first(None)
            .await
            .map_err(|e| format!("leaf_count: {e}"))?;
        Ok(row.map(|r| r.count).unwrap_or(0))
    }

    pub async fn commitment_at(
        &self,
        tree_key: &str,
        leaf_index: u32,
    ) -> Result<Option<[u8; 32]>, String> {
        let row: Option<LevelRow> = self
            .bound(
                "SELECT 0 AS level, nodes_hex FROM tree_levels WHERE tree_key = ?1 AND level = 0",
                vec![s(tree_key)],
            )?
            .first(None)
            .await
            .map_err(|e| format!("commitment_at: {e}"))?;
        Ok(row.and_then(|r| {
            let blob = hex::decode(&r.nodes_hex).ok()?;
            let pos = leaf_index as usize;
            blob.get(pos * 32..pos * 32 + 32)
                .and_then(|sl| sl.try_into().ok())
        }))
    }

    pub async fn is_nullifier_spent(&self, nullifier_hex: &str) -> Result<bool, String> {
        let row: Option<SigRow> = self
            .bound(
                "SELECT signature FROM nullifiers WHERE nullifier_hex = ?1",
                vec![s(nullifier_hex)],
            )?
            .first(None)
            .await
            .map_err(|e| format!("is_nullifier_spent: {e}"))?;
        Ok(row.is_some())
    }

    pub async fn utxos_range(
        &self,
        tree_key: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<UtxoRangeRow>, String> {
        let res = self
            .bound(
                "SELECT leaf_index, commitment_hex, encrypted_output_hex, signature, slot \
                 FROM utxos WHERE tree_key = ?1 AND leaf_index >= ?2 AND leaf_index < ?3 \
                 ORDER BY leaf_index ASC",
                vec![s(tree_key), n(start as i64), n(end as i64)],
            )?
            .all()
            .await
            .map_err(|e| format!("utxos_range: {e}"))?;
        res.results::<UtxoRangeRow>().map_err(|e| format!("utxos_range: {e}"))
    }

    pub async fn utxo_by_encrypted_hex(
        &self,
        encrypted_hex: &str,
        tree_key: Option<&str>,
    ) -> Result<Option<(String, i64, String, String, i64)>, String> {
        let row: Option<UtxoCheckRow> = match tree_key {
            Some(tk) => {
                self.bound(
                    "SELECT tree_key, leaf_index, commitment_hex, signature, slot FROM utxos \
                     WHERE encrypted_output_hex = ?1 AND tree_key = ?2",
                    vec![s(encrypted_hex), s(tk)],
                )?
                .first(None)
                .await
            }
            None => {
                self.bound(
                    "SELECT tree_key, leaf_index, commitment_hex, signature, slot FROM utxos \
                     WHERE encrypted_output_hex = ?1",
                    vec![s(encrypted_hex)],
                )?
                .first(None)
                .await
            }
        }
        .map_err(|e| format!("utxo_by_encrypted_hex: {e}"))?;
        Ok(row.map(|r| (r.tree_key, r.leaf_index, r.commitment_hex, r.signature, r.slot)))
    }

    pub async fn get_notes(&self, wallet: &str) -> Result<Option<(String, String)>, String> {
        let row: Option<NoteRow> = self
            .bound(
                "SELECT ciphertext_hex, updated_at FROM encrypted_notes WHERE wallet_pubkey = ?1",
                vec![s(wallet)],
            )?
            .first(None)
            .await
            .map_err(|e| format!("get_notes: {e}"))?;
        Ok(row.map(|r| (r.ciphertext_hex, r.updated_at)))
    }

    pub async fn put_notes(&self, wallet: &str, ciphertext_hex: &str) -> Result<(), String> {
        self.bound(
            "INSERT INTO encrypted_notes (wallet_pubkey, ciphertext_hex, updated_at) \
             VALUES (?1, ?2, strftime('%Y-%m-%d %H:%M:%S', 'now')) \
             ON CONFLICT (wallet_pubkey) DO UPDATE SET ciphertext_hex = excluded.ciphertext_hex, \
             updated_at = excluded.updated_at",
            vec![s(wallet), s(ciphertext_hex)],
        )?
        .run()
        .await
        .map_err(|e| format!("put_notes: {e}"))?;
        Ok(())
    }

    pub async fn run_batch(&self, stmts: Vec<D1PreparedStatement>) -> Result<(), String> {
        self.db
            .batch(stmts)
            .await
            .map_err(|e| format!("batch: {e}"))?;
        Ok(())
    }
}
