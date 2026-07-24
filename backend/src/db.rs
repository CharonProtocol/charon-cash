use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};

use crate::indexer::{IndexedNullifier, IndexedTransact, IndexedUtxo, TransactKind};

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

impl Db {
    pub async fn connect(database_url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .context("connect to postgres")?;

        let db = Self { pool };
        // Applies `backend/migrations/*.sql` via SQLx's migrator.
        sqlx::migrate!("./migrations")
            .run(&db.pool)
            .await
            .context("run postgres migrations")?;
        Ok(db)
    }

    /// Expose pool for future modules (relayer, sqlx queries in routes).
    #[allow(dead_code)]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn get_cursor(&self) -> Result<(Option<String>, u64)> {
        let row: (Option<String>, i64) =
            sqlx::query_as("SELECT last_signature, last_slot FROM indexer_cursor WHERE id = 1")
                .fetch_one(&self.pool)
                .await?;
        Ok((row.0, row.1 as u64))
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
            "INSERT INTO indexed_txs (signature, slot, tree_key, kind)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (signature) DO NOTHING",
        )
        .bind(&tx.signature)
        .bind(tx.slot as i64)
        .bind(&tx.tree_key)
        .bind(match tx.decoded.kind {
            TransactKind::Sol => "sol",
            TransactKind::Spl => "spl",
        })
        .execute(&mut *conn)
        .await?;

        for utxo in &tx.utxos {
            insert_utxo(&mut conn, utxo).await?;
        }
        for nullifier in &tx.nullifiers {
            insert_nullifier(&mut conn, nullifier).await?;
        }

        let new_next = tx.utxos.iter().map(|u| u.leaf_index + 1).max().unwrap_or(0);

        sqlx::query(
            r#"
            INSERT INTO trees (tree_key, next_index) VALUES ($1, $2)
            ON CONFLICT (tree_key) DO UPDATE SET next_index = EXCLUDED.next_index
            "#,
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

    /// Ordered leaves for a tree — used by the in-memory Merkle mirror.
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

    /// Page encrypted outputs by leaf_index in `[start, end)`.
    pub async fn utxos_range(
        &self,
        tree_key: &str,
        start: u64,
        end: u64,
    ) -> Result<Vec<UtxoRow>> {
        let rows: Vec<(i64, Vec<u8>, String, String, i64)> = sqlx::query_as(
            r#"
            SELECT leaf_index, commitment, encrypted_output_hex, signature, slot
            FROM utxos
            WHERE tree_key = $1 AND leaf_index >= $2 AND leaf_index < $3
            ORDER BY leaf_index ASC
            "#,
        )
        .bind(tree_key)
        .bind(start as i64)
        .bind(end as i64)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|(leaf_index, commitment, encrypted_output_hex, signature, slot)| UtxoRow {
                tree_key: tree_key.to_string(),
                leaf_index: leaf_index as u64,
                commitment,
                encrypted_output_hex,
                signature,
                slot: slot as u64,
            })
            .collect())
    }

    /// Lookup by encrypted_output_hex (optionally scoped to a tree).
    pub async fn utxo_by_encrypted_hex(
        &self,
        encrypted_hex: &str,
        tree_key: Option<&str>,
    ) -> Result<Option<UtxoRow>> {
        let row: Option<(String, i64, Vec<u8>, String, String, i64)> = if let Some(tk) = tree_key {
            sqlx::query_as(
                r#"
                SELECT tree_key, leaf_index, commitment, encrypted_output_hex, signature, slot
                FROM utxos WHERE encrypted_output_hex = $1 AND tree_key = $2
                "#,
            )
            .bind(encrypted_hex)
            .bind(tk)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query_as(
                r#"
                SELECT tree_key, leaf_index, commitment, encrypted_output_hex, signature, slot
                FROM utxos WHERE encrypted_output_hex = $1
                "#,
            )
            .bind(encrypted_hex)
            .fetch_optional(&self.pool)
            .await?
        };

        Ok(row.map(
            |(tree_key, leaf_index, commitment, encrypted_output_hex, signature, slot)| UtxoRow {
                tree_key,
                leaf_index: leaf_index as u64,
                commitment,
                encrypted_output_hex,
                signature,
                slot: slot as u64,
            },
        ))
    }
}

#[derive(Debug, Clone)]
pub struct UtxoRow {
    pub tree_key: String,
    pub leaf_index: u64,
    pub commitment: Vec<u8>,
    pub encrypted_output_hex: String,
    pub signature: String,
    pub slot: u64,
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
