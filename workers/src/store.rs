//! Postgres (Neon HTTP) data access. All binary values round-trip as hex
//! TEXT — the same shapes the D1 layer used, so row semantics are identical.

use serde_json::Value;

use std::sync::OnceLock;

use crate::neon::Neon;

use serde::Deserialize;

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
pub struct NullifierSigRow {
    pub nullifier_hex: String,
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
pub struct RecipientKeyRow {
    pub note_pubkey: String,
    pub enc_pubkey: String,
    pub updated_at: i64,
}

#[derive(Deserialize)]
pub struct RecipientWalletKeyRow {
    pub wallet_pubkey: String,
    pub note_pubkey: String,
    pub enc_pubkey: String,
}

#[derive(Deserialize)]
pub struct UtxoCheckRow {
    pub tree_key: String,
    pub leaf_index: i64,
    pub commitment_hex: String,
    pub signature: String,
    pub slot: i64,
}

/// A bound parameter: TEXT or BIGINT.
#[derive(Clone, Debug)]
pub enum V {
    S(String),
    I(i64),
}

pub fn s(v: impl Into<String>) -> V {
    V::S(v.into())
}

pub fn n(v: i64) -> V {
    V::I(v)
}

/// A statement with its bound parameters, for the write wave.
pub struct Stmt {
    pub sql: String,
    pub params: Vec<V>,
}

pub fn stmt(sql: &str, params: Vec<V>) -> Stmt {
    Stmt { sql: sql.to_string(), params }
}

pub(crate) fn str_at(r: &Value, k: &str) -> String {
    match r.get(k) {
        Some(v) => match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        },
        None => String::new(),
    }
}

pub(crate) fn i64_at(r: &Value, k: &str) -> i64 {
    match r.get(k) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.parse().unwrap_or(0),
        Some(Value::Bool(b)) => *b as i64,
        _ => 0,
    }
}


pub struct Store {
    pub db: Neon,
}

static UI_TABLE_READY: OnceLock<()> = OnceLock::new();

impl Store {
    pub fn new(db: Neon) -> Self {
        Store { db }
    }

    pub async fn get_cursor(&self) -> Result<(Option<String>, u64), String> {
        let rows = self
            .db
            .query("SELECT last_signature, last_slot FROM indexer_cursor WHERE id = 1", &[])
            .await?;
        Ok(rows
            .first()
            .map(|r| {
                let sig = match r.get("last_signature") {
                    Some(Value::String(x)) => Some(x.clone()),
                    _ => None,
                };
                (sig, i64_at(r, "last_slot") as u64)
            })
            .unwrap_or((None, 0)))
    }

    pub async fn set_cursor(&self, signature: &str, slot: u64) -> Result<(), String> {
        self.db
            .query(
                "UPDATE indexer_cursor SET last_signature = $1, last_slot = $2 WHERE id = 1",
                &[s(signature), n(slot as i64)],
            )
            .await
            .map(|_| ())
    }

    pub async fn has_tx(&self, signature: &str) -> Result<bool, String> {
        let rows = self
            .db
            .query(
                "SELECT signature FROM indexed_txs WHERE signature = $1",
                &[s(signature)],
            )
            .await?;
        Ok(!rows.is_empty())
    }

    pub async fn try_acquire_lock(&self, token: &str, now_ms: i64) -> Result<bool, String> {
        let stale_before = now_ms - 30_000;
        let rows = self
            .db
            .query(
                "UPDATE sync_lock SET token = $1, ts = $2 \
                 WHERE id = 1 AND (token IS NULL OR ts < $3) RETURNING token",
                &[s(token), n(now_ms), n(stale_before)],
            )
            .await?;
        Ok(!rows.is_empty())
    }

    pub async fn release_lock(&self, token: &str) -> Result<(), String> {
        self.db
            .query(
                "UPDATE sync_lock SET token = NULL, ts = 0 WHERE id = 1 AND token = $1",
                &[s(token)],
            )
            .await
            .map(|_| ())
    }

    pub async fn tree_row(&self, tree_key: &str) -> Result<Option<TreeRow>, String> {
        let rows = self
            .db
            .query(
                "SELECT next_index, root_index, root_history_hex FROM trees WHERE tree_key = $1",
                &[s(tree_key)],
            )
            .await?;
        Ok(rows.first().map(|r| TreeRow {
            next_index: i64_at(r, "next_index"),
            root_index: i64_at(r, "root_index"),
            root_history_hex: str_at(r, "root_history_hex"),
        }))
    }

    pub async fn level_rows(&self, tree_key: &str) -> Result<Vec<LevelRow>, String> {
        let rows = self
            .db
            .query(
                "SELECT level, nodes_hex FROM tree_levels WHERE tree_key = $1 ORDER BY level",
                &[s(tree_key)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| LevelRow {
                level: i64_at(r, "level"),
                nodes_hex: str_at(r, "nodes_hex"),
            })
            .collect())
    }

    pub async fn leaf_count(&self, tree_key: &str) -> Result<i64, String> {
        let rows = self
            .db
            .query(
                "SELECT COUNT(*)::BIGINT FROM utxos WHERE tree_key = $1",
                &[s(tree_key)],
            )
            .await?;
        Ok(rows.first().map(|r| i64_at(r, "count")).unwrap_or(0))
    }

    pub async fn commitment_at(
        &self,
        tree_key: &str,
        leaf_index: u32,
    ) -> Result<Option<[u8; 32]>, String> {
        let rows = self
            .db
            .query(
                "SELECT nodes_hex FROM tree_levels WHERE tree_key = $1 AND level = 0",
                &[s(tree_key)],
            )
            .await?;
        let Some(row) = rows.first() else { return Ok(None) };
        let blob = hex::decode(&str_at(row, "nodes_hex")).map_err(|e| format!("nodes hex: {e}"))?;
        let pos = leaf_index as usize;
        Ok(blob
            .get(pos * 32..pos * 32 + 32)
            .and_then(|sl| sl.try_into().ok()))
    }

    /// Where a commitment already sits in the tree, if anywhere. The sync
    /// uses this to detect a tx whose leaves were applied by a torn write
    /// wave (subrequest budget cut it mid-flight) before `indexed_txs` made
    /// that visible — re-appending those leaves would corrupt the mirror.
    pub async fn commitment_leaf_index(
        &self,
        tree_key: &str,
        commitment_hex: &str,
    ) -> Result<Option<i64>, String> {
        let rows = self
            .db
            .query(
                "SELECT leaf_index FROM utxos WHERE tree_key = $1 AND commitment_hex = $2 LIMIT 1",
                &[s(tree_key), s(commitment_hex)],
            )
            .await?;
        Ok(rows.first().map(|r| i64_at(r, "leaf_index")))
    }

    pub async fn is_nullifier_spent(&self, nullifier_hex: &str) -> Result<bool, String> {
        let rows = self
            .db
            .query(
                "SELECT signature FROM nullifiers WHERE nullifier_hex = $1",
                &[s(nullifier_hex)],
            )
            .await?;
        Ok(!rows.is_empty())
    }

    /// The transaction that spent a nullifier, so conflict errors can point the
    /// client at the landing it may have misread as a failure.
    pub async fn nullifier_spent_by(
        &self,
        nullifier_hex: &str,
    ) -> Result<Option<String>, String> {
        let rows = self
            .db
            .query(
                "SELECT signature FROM nullifiers WHERE nullifier_hex = $1",
                &[s(nullifier_hex)],
            )
            .await?;
        Ok(rows.first().map(|r| str_at(r, "signature")))
    }

    /// Spent signatures for many nullifiers in one query — the unlock scan
    /// checks hundreds of nullifiers per pass and per-note lookups made every
    /// pass pay a round trip per note. Missing hexes are simply absent.
    /// Caller must keep each batch <= 90.
    pub async fn nullifiers_spent(
        &self,
        nullifier_hexes: &[String],
    ) -> Result<Vec<(String, String)>, String> {
        if nullifier_hexes.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db
            .query(
                "SELECT nullifier_hex, signature FROM nullifiers \
                 WHERE nullifier_hex = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
                &[V::S(serde_json::to_string(nullifier_hexes).map_err(|e| e.to_string())?)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| (str_at(r, "nullifier_hex"), str_at(r, "signature")))
            .collect())
    }

    pub async fn utxos_range(
        &self,
        tree_key: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<UtxoRangeRow>, String> {
        let rows = self
            .db
            .query(
                "SELECT leaf_index, commitment_hex, encrypted_output_hex, signature, slot \
                 FROM utxos WHERE tree_key = $1 AND leaf_index >= $2 AND leaf_index < $3 \
                 ORDER BY leaf_index ASC",
                &[s(tree_key), n(start as i64), n(end as i64)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| UtxoRangeRow {
                leaf_index: i64_at(r, "leaf_index"),
                commitment_hex: str_at(r, "commitment_hex"),
                encrypted_output_hex: str_at(r, "encrypted_output_hex"),
                signature: str_at(r, "signature"),
                slot: i64_at(r, "slot"),
            })
            .collect())
    }

    pub async fn utxo_by_encrypted_hex(
        &self,
        encrypted_hex: &str,
        tree_key: Option<&str>,
    ) -> Result<Option<(String, i64, String, String, i64)>, String> {
        let rows = match tree_key {
            Some(tk) => {
                self.db
                    .query(
                        "SELECT tree_key, leaf_index, commitment_hex, signature, slot FROM utxos \
                         WHERE encrypted_output_hex = $1 AND tree_key = $2",
                        &[s(encrypted_hex), s(tk)],
                    )
                    .await?
            }
            None => {
                self.db
                    .query(
                        "SELECT tree_key, leaf_index, commitment_hex, signature, slot FROM utxos \
                         WHERE encrypted_output_hex = $1",
                        &[s(encrypted_hex)],
                    )
                    .await?
            }
        };
        Ok(rows.first().map(|r| {
            (
                str_at(r, "tree_key"),
                i64_at(r, "leaf_index"),
                str_at(r, "commitment_hex"),
                str_at(r, "signature"),
                i64_at(r, "slot"),
            )
        }))
    }

    pub async fn get_notes(&self, wallet: &str) -> Result<Option<(String, String)>, String> {
        let rows = self
            .db
            .query(
                "SELECT ciphertext_hex, updated_at FROM encrypted_notes WHERE wallet_pubkey = $1",
                &[s(wallet)],
            )
            .await?;
        Ok(rows.first().map(|r| (str_at(r, "ciphertext_hex"), str_at(r, "updated_at"))))
    }

    pub async fn put_notes(&self, wallet: &str, ciphertext_hex: &str) -> Result<(), String> {
        self.db
            .query(
                "INSERT INTO encrypted_notes (wallet_pubkey, ciphertext_hex, updated_at) \
                 VALUES ($1, $2, to_char(now(), 'YYYY-MM-DD HH24:MI:SS')) \
                 ON CONFLICT (wallet_pubkey) DO UPDATE SET ciphertext_hex = EXCLUDED.ciphertext_hex, \
                 updated_at = EXCLUDED.updated_at",
                &[s(wallet), s(ciphertext_hex)],
            )
            .await
            .map(|_| ())
    }

    pub async fn get_ui_doc(&self, wallet: &str, doc_key: &str) -> Result<Option<(String, String)>, String> {
        self.ensure_ui_table().await?;
        let rows = self
            .db
            .query(
                "SELECT doc, updated_at FROM ui_docs WHERE wallet_pubkey = $1 AND doc_key = $2",
                &[s(wallet), s(doc_key)],
            )
            .await?;
        Ok(rows.first().map(|r| (str_at(r, "doc"), str_at(r, "updated_at"))))
    }

    pub async fn put_ui_doc(&self, wallet: &str, doc_key: &str, doc: &str) -> Result<(), String> {
        self.ensure_ui_table().await?;
        self.db
            .query(
                "INSERT INTO ui_docs (wallet_pubkey, doc_key, doc, updated_at) \
                 VALUES ($1, $2, $3, to_char(now(), 'YYYY-MM-DD HH24:MI:SS')) \
                 ON CONFLICT (wallet_pubkey, doc_key) DO UPDATE SET doc = EXCLUDED.doc, \
                 updated_at = EXCLUDED.updated_at",
                &[s(wallet), s(doc_key), s(doc)],
            )
            .await
            .map(|_| ())
    }

    async fn ensure_ui_table(&self) -> Result<(), String> {
        if UI_TABLE_READY.get().is_some() {
            return Ok(());
        }
        self.db
            .query(
                "CREATE TABLE IF NOT EXISTS ui_docs (\
                     wallet_pubkey TEXT NOT NULL, \
                     doc_key TEXT NOT NULL, \
                     doc TEXT NOT NULL, \
                     updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), \
                     PRIMARY KEY (wallet_pubkey, doc_key))",
                &[],
            )
            .await
            .map(|_| ())?;
        let _ = UI_TABLE_READY.set(());
        Ok(())
    }

    pub async fn get_recipient_keys(
        &self,
        wallet: &str,
    ) -> Result<Option<(String, String, i64)>, String> {
        let rows = self
            .db
            .query(
                "SELECT note_pubkey, enc_pubkey, updated_at FROM recipient_keys WHERE wallet_pubkey = $1",
                &[s(wallet)],
            )
            .await?;
        Ok(rows
            .first()
            .map(|r| (str_at(r, "note_pubkey"), str_at(r, "enc_pubkey"), i64_at(r, "updated_at"))))
    }

    /// Registered receive keys for many wallets in one query — the payroll
    /// pre-run "check recipients" pass used to pay a round trip per employee.
    /// Unregistered wallets are simply absent from the result.
    pub async fn recipients_many(
        &self,
        wallets: &[String],
    ) -> Result<Vec<(String, String, String)>, String> {
        if wallets.is_empty() {
            return Ok(Vec::new());
        }
        // The HTTP driver takes JSON params; pass the wallet list as a JSON
        // array string and let PG's jsonb bridge expand it for the ANY match.
        let json_array = serde_json::to_string(wallets).map_err(|e| e.to_string())?;
        let rows = self
            .db
            .query(
                "SELECT wallet_pubkey, note_pubkey, enc_pubkey FROM recipient_keys \
                 WHERE wallet_pubkey = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
                &[V::S(json_array)],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| (str_at(r, "wallet_pubkey"), str_at(r, "note_pubkey"), str_at(r, "enc_pubkey")))
            .collect())
    }

    pub async fn put_recipient_keys(
        &self,
        wallet: &str,
        note_pubkey: &str,
        enc_pubkey: &str,
    ) -> Result<(), String> {
        self.db
            .query(
                "INSERT INTO recipient_keys (wallet_pubkey, note_pubkey, enc_pubkey, updated_at) \
                 VALUES ($1, $2, $3, EXTRACT(EPOCH FROM now())::BIGINT) \
                 ON CONFLICT (wallet_pubkey) DO UPDATE SET note_pubkey = EXCLUDED.note_pubkey, \
                 enc_pubkey = EXCLUDED.enc_pubkey, updated_at = EXCLUDED.updated_at",
                &[s(wallet), s(note_pubkey), s(enc_pubkey)],
            )
            .await
            .map(|_| ())
    }

    /// One statement, for the single-write call sites (merkle tree init).
    pub async fn run_one(&self, sql: &str, params: Vec<V>) -> Result<(), String> {
        self.db.query(sql, &params).await.map(|_| ())
    }

    /// Sequential write wave. Non-atomic but idempotent: every statement is
    /// ON CONFLICT DO NOTHING/UPDATE and indexed_txs dedups re-runs, so a
    /// partial wave is safely completed by the next sync.
    pub async fn run_batch(&self, stmts: Vec<Stmt>) -> Result<(), String> {
        for s in &stmts {
            self.db.query(&s.sql, &s.params).await.map(|_| ())?;
        }
        Ok(())
    }
}
