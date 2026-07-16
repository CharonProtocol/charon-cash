use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};

use crate::indexer::{IndexedNullifier, IndexedTransact, IndexedUtxo, TransactKind};

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

/// One leaf as served to a scanning client.
pub struct LeafRow {
    pub leaf_index: i64,
    pub commitment: Vec<u8>,
    pub encrypted_output: Vec<u8>,
    pub slot: i64,
}

impl Db {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .context("connect to postgres")?;

        let db = Self { pool };
        sqlx::migrate!("./migrations")
            .run(&db.pool)
            .await
            .context("run postgres migrations")?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Liveness probe: a trivial query that fails if the pool/DB is unhealthy.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    pub async fn get_cursor(&self) -> Result<(Option<String>, u64)> {
        let row: (Option<String>, i64) =
            sqlx::query_as("SELECT last_signature, last_slot FROM indexer_cursor WHERE id = 1")
                .fetch_one(&self.pool)
                .await?;
        Ok((row.0, row.1 as u64))
    }

    /// Slot to resume the geyser stream from on startup. `+1` so we don't re-request the last slot
    /// we already fully processed (idempotency still protects us if we do).
    pub async fn resume_from_slot(&self) -> Result<Option<u64>> {
        let (_, slot) = self.get_cursor().await?;
        Ok(if slot == 0 { None } else { Some(slot + 1) })
    }

    pub async fn set_cursor(&self, signature: &str, slot: u64) -> Result<()> {
        sqlx::query("UPDATE indexer_cursor SET last_signature = $1, last_slot = $2 WHERE id = 1")
            .bind(signature)
            .bind(slot as i64)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn has_tx(&self, signature: &str) -> Result<bool> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT signature FROM indexed_txs WHERE signature = $1")
                .bind(signature)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.is_some())
    }

    /// On-DB next free leaf index for a tree (0 if the tree is unseen). Used for startup
    /// reconciliation against the chain, not for assigning indices — those come from the event.
    pub async fn next_index(&self, tree_key: &str) -> Result<u32> {
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT next_index FROM trees WHERE tree_key = $1")
                .bind(tree_key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0 as u32).unwrap_or(0))
    }

    pub async fn insert_transact(&self, tx: &IndexedTransact) -> Result<()> {
        let mut conn: Transaction<'_, Postgres> = self.pool.begin().await?;

        sqlx::query(
            "INSERT INTO indexed_txs (signature, slot, tree_key, kind, root)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (signature) DO NOTHING",
        )
        .bind(&tx.signature)
        .bind(tx.slot as i64)
        .bind(&tx.tree_key)
        .bind(match tx.kind {
            TransactKind::Sol => "sol",
            TransactKind::Spl => "spl",
        })
        .bind(tx.event_root.as_slice())
        .execute(&mut *conn)
        .await?;

        for utxo in &tx.utxos {
            insert_utxo(&mut conn, utxo).await?;
        }
        for nullifier in &tx.nullifiers {
            insert_nullifier(&mut conn, nullifier).await?;
        }

        // next_index is the max leaf index seen + 1, and can only move forward. GREATEST guards
        // against an out-of-order or duplicate delivery walking the counter backwards.
        let new_next = tx.utxos.iter().map(|u| u.leaf_index + 1).max().unwrap_or(0);

        sqlx::query(
            "INSERT INTO trees (tree_key, next_index) VALUES ($1, $2)
             ON CONFLICT (tree_key) DO UPDATE SET next_index = GREATEST(trees.next_index, EXCLUDED.next_index)",
        )
        .bind(&tx.tree_key)
        .bind(new_next as i64)
        .execute(&mut *conn)
        .await?;

        sqlx::query("UPDATE indexer_cursor SET last_signature = $1, last_slot = $2 WHERE id = 1")
            .bind(&tx.signature)
            .bind(tx.slot as i64)
            .execute(&mut *conn)
            .await?;

        conn.commit().await?;
        Ok(())
    }

    pub async fn utxo_count(&self, tree_key: &str) -> Result<u64> {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*)::BIGINT FROM utxos WHERE tree_key = $1")
            .bind(tree_key)
            .fetch_one(&self.pool)
            .await?;
        Ok(row.0 as u64)
    }

    /// Leaves in `[from, to)` leaf-index order — the client scan feed. Bounded so a client pages
    /// rather than pulling the whole tree at once.
    pub async fn get_leaves(&self, tree_key: &str, from: i64, to: i64) -> Result<Vec<LeafRow>> {
        let rows: Vec<(i64, Vec<u8>, Vec<u8>, i64)> = sqlx::query_as(
            "SELECT leaf_index, commitment, encrypted_output, slot
             FROM utxos WHERE tree_key = $1 AND leaf_index >= $2 AND leaf_index < $3
             ORDER BY leaf_index ASC",
        )
        .bind(tree_key)
        .bind(from)
        .bind(to)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(leaf_index, commitment, encrypted_output, slot)| LeafRow {
                leaf_index,
                commitment,
                encrypted_output,
                slot,
            })
            .collect())
    }

    /// All nullifier byte-strings at or after `from_slot`, for local spent-checks.
    pub async fn get_nullifiers(&self, tree_key: &str, from_slot: i64) -> Result<Vec<Vec<u8>>> {
        let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
            "SELECT nullifier FROM nullifiers WHERE tree_key = $1 AND slot >= $2 ORDER BY slot ASC",
        )
        .bind(tree_key)
        .bind(from_slot)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }

    /// Ordered commitments for a tree, used to rebuild the Merkle mirror.
    pub async fn load_commitments(&self, tree_key: &str) -> Result<Vec<[u8; 32]>> {
        let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
            "SELECT commitment FROM utxos WHERE tree_key = $1 ORDER BY leaf_index ASC",
        )
        .bind(tree_key)
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::with_capacity(rows.len());
        for (bytes,) in rows {
            let arr: [u8; 32] = bytes
                .as_slice()
                .try_into()
                .context("commitment must be 32 bytes")?;
            out.push(arr);
        }
        Ok(out)
    }

    /// The most recently indexed event root for a tree (what the chain's current root should be).
    pub async fn latest_root(&self, tree_key: &str) -> Result<Option<Vec<u8>>> {
        let row: Option<(Option<Vec<u8>>,)> = sqlx::query_as(
            "SELECT root FROM indexed_txs WHERE tree_key = $1 ORDER BY slot DESC LIMIT 1",
        )
        .bind(tree_key)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|r| r.0))
    }
}

async fn insert_utxo(conn: &mut Transaction<'_, Postgres>, utxo: &IndexedUtxo) -> Result<()> {
    let hex = hex::encode(&utxo.encrypted_output);
    sqlx::query(
        r#"
        INSERT INTO utxos (
            tree_key, leaf_index, commitment, encrypted_output, encrypted_output_hex,
            signature, slot, ext_amount, fee
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (tree_key, leaf_index) DO NOTHING
        "#,
    )
    .bind(&utxo.tree_key)
    .bind(utxo.leaf_index as i64)
    .bind(utxo.commitment.as_slice())
    .bind(&utxo.encrypted_output)
    .bind(hex)
    .bind(&utxo.signature)
    .bind(utxo.slot as i64)
    .bind(utxo.ext_amount)
    .bind(utxo.fee as i64)
    .execute(&mut **conn)
    .await?;
    Ok(())
}

async fn insert_nullifier(
    conn: &mut Transaction<'_, Postgres>,
    nullifier: &IndexedNullifier,
) -> Result<()> {
    if nullifier.nullifier == [0u8; 32] {
        return Ok(());
    }
    sqlx::query(
        r#"
        INSERT INTO nullifiers (nullifier, tree_key, signature, slot)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (nullifier) DO NOTHING
        "#,
    )
    .bind(nullifier.nullifier.as_slice())
    .bind(&nullifier.tree_key)
    .bind(&nullifier.signature)
    .bind(nullifier.slot as i64)
    .execute(&mut **conn)
    .await?;
    Ok(())
}
