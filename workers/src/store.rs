//! Postgres (Neon via Hyperdrive) data access. All binary values round-trip
//! as hex TEXT — the same shapes the D1 layer used, so row structs and the
//! SQL surface stay identical; only the driver changed.

use serde::Deserialize;
use std::sync::Arc;
use tokio_postgres::types::{ToSql, IsNull, Type};

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

impl ToSql for V {
    fn to_sql(
        &self,
        t: &Type,
        out: &mut tokio_postgres::types::private::BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self {
            V::S(x) => x.to_sql(t, out),
            V::I(x) => x.to_sql(t, out),
        }
    }

    fn accepts(t: &Type) -> bool {
        <String as ToSql>::accepts(t) || <i64 as ToSql>::accepts(t)
    }

    tokio_postgres::types::to_sql_checked!();
}

/// A statement with its bound parameters, for the batch path.
pub struct Stmt {
    pub sql: String,
    pub params: Vec<V>,
}

pub fn stmt(sql: &str, params: Vec<V>) -> Stmt {
    Stmt { sql: sql.to_string(), params }
}

fn refs(params: &[V]) -> Vec<&(dyn ToSql + Sync)> {
    params.iter().map(|v| v as &(dyn ToSql + Sync)).collect()
}

pub struct Store {
    pub db: crate::state::Db,
}

impl Store {
    pub fn new(db: crate::state::Db) -> Self {
        Store { db }
    }

    /// A fresh connection per operation: Hyperdrive pools the origin side,
    /// so the handshake is cheap and every method owns its Client (which
    /// `transaction()` requires). Matches the workers-rs tokio-postgres
    /// example's connect-per-request pattern.
    async fn client(&self) -> Result<tokio_postgres::Client, String> {
        self.db.connect().await
    }

    pub async fn get_cursor(&self) -> Result<(Option<String>, u64), String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                "SELECT last_signature, last_slot FROM indexer_cursor WHERE id = 1",
                &[],
            )
            .await.map_err(|e| format!("pg: {e}"))?;
        let r = row.map(|row| {
            let last_signature: Option<String> = row.get(0);
            let last_slot: i64 = row.get(1);
            (last_signature, last_slot)
        });
        Ok(r.map(|(a, b)| (a, b as u64)).unwrap_or((None, 0)))
    }

    pub async fn set_cursor(&self, signature: &str, slot: u64) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "UPDATE indexer_cursor SET last_signature = $1, last_slot = $2 WHERE id = 1",
                &[&signature, &(slot as i64)],
            )
            .await
            .map_err(|e| format!("pg: {e}"))?;
        Ok(())
    }

    pub async fn has_tx(&self, signature: &str) -> Result<bool, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT signature FROM indexed_txs WHERE signature = $1",
                    &[&signature],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.is_some())
    }

    pub async fn try_acquire_lock(&self, token: &str, now_ms: i64) -> Result<bool, String> {
        let stale_before = now_ms - 30_000;
        let client = self.client().await?;
        let n = client
            .execute(
                    "UPDATE sync_lock SET token = $1, ts = $2 \
                     WHERE id = 1 AND (token IS NULL OR ts < $3)",
                    &[&token, &now_ms, &stale_before],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(n > 0)
    }

    pub async fn release_lock(&self, token: &str) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "UPDATE sync_lock SET token = NULL, ts = 0 WHERE id = 1 AND token = $1",
                &[&token],
            )
            .await
            .map_err(|e| format!("pg: {e}"))?;
        Ok(())
    }

    pub async fn tree_row(&self, tree_key: &str) -> Result<Option<TreeRow>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT next_index, root_index, root_history_hex FROM trees WHERE tree_key = $1",
                    &[&tree_key],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.map(|row| TreeRow {
            next_index: row.get(0),
            root_index: row.get(1),
            root_history_hex: row.get(2),
        }))
    }

    pub async fn level_rows(&self, tree_key: &str) -> Result<Vec<LevelRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                    "SELECT level, nodes_hex FROM tree_levels WHERE tree_key = $1 ORDER BY level",
                    &[&tree_key],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(rows
            .into_iter()
            .map(|row| LevelRow {
                level: row.get(0),
                nodes_hex: row.get(1),
            })
            .collect())
    }

    pub async fn leaf_count(&self, tree_key: &str) -> Result<i64, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT COUNT(*)::BIGINT FROM utxos WHERE tree_key = $1",
                    &[&tree_key],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.map(|row| {
            let count: i64 = row.get(0);
            count
        }).unwrap_or(0))
    }

    pub async fn commitment_at(
        &self,
        tree_key: &str,
        leaf_index: u32,
    ) -> Result<Option<[u8; 32]>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT nodes_hex FROM tree_levels WHERE tree_key = $1 AND level = 0",
                    &[&tree_key],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.and_then(|row| {
            let nodes_hex: String = row.get(0);
            let blob = hex::decode(&nodes_hex).ok()?;
            let pos = leaf_index as usize;
            blob.get(pos * 32..pos * 32 + 32)
                .and_then(|sl| sl.try_into().ok())
        }))
    }

    pub async fn is_nullifier_spent(&self, nullifier_hex: &str) -> Result<bool, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT signature FROM nullifiers WHERE nullifier_hex = $1",
                    &[&nullifier_hex],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.is_some())
    }

    /// The transaction that spent a nullifier, so conflict errors can point the
    /// client at the landing it may have misread as a failure.
    pub async fn nullifier_spent_by(
        &self,
        nullifier_hex: &str,
    ) -> Result<Option<String>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT signature FROM nullifiers WHERE nullifier_hex = $1",
                    &[&nullifier_hex],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.map(|row| {
            let signature: String = row.get(0);
            signature
        }))
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
        let client = self.client().await?;
        let rows = client
            .query(
                    "SELECT nullifier_hex, signature FROM nullifiers WHERE nullifier_hex = ANY($1)",
                    &[&nullifier_hexes],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let nullifier_hex: String = row.get(0);
                let signature: String = row.get(1);
                (nullifier_hex, signature)
            })
            .collect())
    }

    pub async fn utxos_range(
        &self,
        tree_key: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<UtxoRangeRow>, String> {
        let client = self.client().await?;
        let rows = client
            .query(
                    "SELECT leaf_index, commitment_hex, encrypted_output_hex, signature, slot \
                     FROM utxos WHERE tree_key = $1 AND leaf_index >= $2 AND leaf_index < $3 \
                     ORDER BY leaf_index ASC",
                    &[&tree_key, &(start as i64), &(end as i64)],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(rows
            .into_iter()
            .map(|row| UtxoRangeRow {
                leaf_index: row.get(0),
                commitment_hex: row.get(1),
                encrypted_output_hex: row.get(2),
                signature: row.get(3),
                slot: row.get(4),
            })
            .collect())
    }

    pub async fn utxo_by_encrypted_hex(
        &self,
        encrypted_hex: &str,
        tree_key: Option<&str>,
    ) -> Result<Option<(String, i64, String, String, i64)>, String> {
        let client = self.client().await?;
        let rows = match tree_key {
            Some(tk) => {
                client
                    .query(
                        "SELECT tree_key, leaf_index, commitment_hex, signature, slot FROM utxos \
                         WHERE encrypted_output_hex = $1 AND tree_key = $2",
                        &[&encrypted_hex, &tk],
                    )
                    .await
                    .map_err(|e| format!("pg: {e}"))?
            }
            None => {
                client
                    .query(
                        "SELECT tree_key, leaf_index, commitment_hex, signature, slot FROM utxos \
                         WHERE encrypted_output_hex = $1",
                        &[&encrypted_hex],
                    )
                    .await
                    .map_err(|e| format!("pg: {e}"))?
            }
        };
        Ok(rows.into_iter().next().map(|row| {
            (
                row.get::<_, String>(0),
                row.get::<_, i64>(1),
                row.get::<_, String>(2),
                row.get::<_, String>(3),
                row.get::<_, i64>(4),
            )
        }))
    }

    pub async fn get_notes(&self, wallet: &str) -> Result<Option<(String, String)>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT ciphertext_hex, updated_at FROM encrypted_notes WHERE wallet_pubkey = $1",
                    &[&wallet],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.map(|row| {
            let ciphertext_hex: String = row.get(0);
            let updated_at: String = row.get(1);
            (ciphertext_hex, updated_at)
        }))
    }

    pub async fn put_notes(&self, wallet: &str, ciphertext_hex: &str) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "INSERT INTO encrypted_notes (wallet_pubkey, ciphertext_hex, updated_at) \
                 VALUES ($1, $2, to_char(now(), 'YYYY-MM-DD HH24:MI:SS')) \
                 ON CONFLICT (wallet_pubkey) DO UPDATE SET ciphertext_hex = EXCLUDED.ciphertext_hex, \
                 updated_at = EXCLUDED.updated_at",
                &[&wallet, &ciphertext_hex],
            )
            .await
            .map_err(|e| format!("pg: {e}"))?;
        Ok(())
    }

    pub async fn get_recipient_keys(
        &self,
        wallet: &str,
    ) -> Result<Option<(String, String, i64)>, String> {
        let client = self.client().await?;
        let row = client
            .query_opt(
                    "SELECT note_pubkey, enc_pubkey, updated_at FROM recipient_keys WHERE wallet_pubkey = $1",
                    &[&wallet],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(row.map(|row| {
            (
                row.get::<_, String>(0),
                row.get::<_, String>(1),
                row.get::<_, i64>(2),
            )
        }))
    }

    /// Registered receive keys for many wallets in one query — the payroll
    /// pre-run "check recipients" pass used to pay a round trip per employee
    /// (100 × ~0.6s serially). Unregistered wallets are simply absent from
    /// the result. Caller must keep each batch <= 90.
    pub async fn recipients_many(
        &self,
        wallets: &[String],
    ) -> Result<Vec<(String, String, String)>, String> {
        if wallets.is_empty() {
            return Ok(Vec::new());
        }
        let client = self.client().await?;
        let rows = client
            .query(
                    "SELECT wallet_pubkey, note_pubkey, enc_pubkey FROM recipient_keys \
                     WHERE wallet_pubkey = ANY($1)",
                    &[&wallets],
                )
            .await.map_err(|e| format!("pg: {e}"))?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get::<_, String>(0),
                    row.get::<_, String>(1),
                    row.get::<_, String>(2),
                )
            })
            .collect())
    }

    pub async fn put_recipient_keys(
        &self,
        wallet: &str,
        note_pubkey: &str,
        enc_pubkey: &str,
    ) -> Result<(), String> {
        let client = self.client().await?;
        client
            .execute(
                "INSERT INTO recipient_keys (wallet_pubkey, note_pubkey, enc_pubkey, updated_at) \
                 VALUES ($1, $2, $3, EXTRACT(EPOCH FROM now())::BIGINT) \
                 ON CONFLICT (wallet_pubkey) DO UPDATE SET note_pubkey = EXCLUDED.note_pubkey, \
                 enc_pubkey = EXCLUDED.enc_pubkey, updated_at = EXCLUDED.updated_at",
                &[&wallet, &note_pubkey, &enc_pubkey],
            )
            .await
            .map_err(|e| format!("pg: {e}"))?;
        Ok(())
    }

    /// One statement, for the single-write call sites (merkle tree init).
    pub async fn run_one(&self, sql: &str, params: Vec<V>) -> Result<(), String> {
        let client = self.client().await?;
        let refs = refs(&params);
        client
            .execute(sql, refs.as_slice())
            .await
            .map_err(|e| format!("pg: {e}"))?;
        Ok(())
    }

    /// All statements in one transaction (the sync write wave).
    pub async fn run_batch(&self, stmts: Vec<Stmt>) -> Result<(), String> {
        let mut client = self.client().await?;
        let tx = client
            .transaction()
            .await
            .map_err(|e| format!("batch tx: {e}"))?;
        for s in &stmts {
            let r: Vec<&(dyn ToSql + Sync)> =
                s.params.iter().map(|v| v as &(dyn ToSql + Sync)).collect();
            tx.execute(&s.sql, r.as_slice())
                .await
                .map_err(|e| format!("batch exec: {e}"))?;
        }
        tx.commit().await.map_err(|e| format!("batch commit: {e}"))?;
        Ok(())
    }
}
