use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Connection, Executor, PgConnection, PgExecutor, PgPool, Postgres, Row, Transaction};
use std::str::FromStr;

use crate::indexer::{IndexedTransact, TransactKind};
use crate::response::{ApiError, ApiErrorCode};

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

impl Db {
    pub async fn connect(database_url: &str) -> Self {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .expect("connect to database");

        let db = Self { pool };
        // Applies `backend/migrations/*.sql` via SQLx's migrator.
        sqlx::migrate!("./migrations")
            .run(&db.pool)
            .await
            .expect("run postgres migrations");
        db
    }

    /// Expose pool for future modules (relayer, sqlx queries in routes).
    #[allow(dead_code)]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn get_cursor(&self) -> Result<(Option<String>, u64), DbError> {
        let row: (Option<String>, i64) =
            sqlx::query_as("SELECT last_signature, last_slot FROM indexer_cursor WHERE id = 1")
                .fetch_one(&self.pool)
                .await?;
        Ok((row.0, row.1 as u64))
    }

    pub async fn set_cursor(&self, signature: &str, slot: u64) -> Result<(), DbError> {
        sqlx::query("UPDATE indexer_cursor SET last_signature = $1, last_slot = $2 WHERE id = 1")
            .bind(signature)
            .bind(slot as i64)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn has_tx(&self, signature: &str) -> Result<bool, DbError> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT signature FROM indexed_txs WHERE signature = $1")
                .bind(signature)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.is_some())
    }

    pub async fn add_user(
        &self,
        wallet_pubkey: String,
        viewing_pubkey: Vec<u8>,
    ) -> Result<(), DbError> {
        let query =
            sqlx::query("INSERT INTO users (wallet_pubkey, viewing_pubkey) VALUES ($1, $2)")
                .bind(wallet_pubkey)
                .bind(viewing_pubkey)
                .execute(&self.pool)
                .await?;

        Ok(())
    }

    pub async fn get_viewing_key(&self, wallet_pubkey: String) -> Result<Vec<u8>, DbError> {
        let query = sqlx::query("SELECT viewing_pubkey FROM users WHERE wallet_pubkey = $1")
            .bind(wallet_pubkey)
            .fetch_one(&self.pool)
            .await?;
        let ret = query.try_get("viewing_pubkey")?;
        Ok(ret)
    }

    pub async fn has_wallet_pubkey(&self, wallet_pubkey: &str) -> Result<bool, DbError> {
        let row = sqlx::query("SELECT 1 FROM users WHERE wallet_pubkey = $1")
            .bind(wallet_pubkey)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    pub async fn next_index(&self, tree_key: &str) -> Result<u32, DbError> {
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT next_index FROM trees WHERE tree_key = $1")
                .bind(tree_key)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.0 as u32).unwrap_or(0))
    }

    /// Fetch commitments from DB starting from leaf_index.
    ///
    /// # Args
    ///     * `leaf_index` : index after which commitments are required
    ///     * `limit` : number of commitments to fetch
    ///     * `tree_key` : bs::58 encoded mint_address for the tree
    /// # Returns
    ///     Vector of (leaf_index, commitment).
    ///
    /// Shall be used for building merkle tree on backend
    pub async fn fetch_commitments(
        &self,
        leaf_index: u64,
        limit: u16,
        tree_key: &String,
    ) -> Result<Vec<(u64, Vec<u8>)>, DbError> {
        let rows = sqlx::query::<sqlx::Postgres>(
            "SELECT * FROM commitments WHERE tree_key = $1 AND leaf_index >= $2 LIMIT $3",
        )
        .bind(tree_key)
        .bind(leaf_index as i64)
        .bind(limit as i32)
        .fetch_all(&self.pool)
        .await?;

        let mut ret: Vec<(u64, Vec<u8>)> = Vec::new();
        for row in rows {
            let leaf_index = row.try_get::<i64, _>("leaf_index")?;
            let commitment = row.try_get("commitment")?;

            ret.push((leaf_index.abs() as u64, commitment));
        }

        Ok(ret)
    }

    /// Fetch notes.
    ///
    /// # Args
    ///     * `start_from` : index after which notes are required
    ///     * `limit` : number of notes to fetch
    /// # Returns
    ///     Vector of (ephemeral_pubkey, ciphertext).
    ///
    /// this will be mostly used for client's note lookups.
    pub async fn fetch_notes(
        &self,
        start_from: u64,
        limit: u16,
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>, DbError> {
        let rows = sqlx::query::<sqlx::Postgres>(
            "SELECT ephemeral_pubkey, ciphertext FROM notes WHERE id > $1 LIMIT $2",
        )
        .bind(start_from as i64)
        .bind(limit as i32)
        .fetch_all(&self.pool)
        .await?;

        let mut ret: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        for row in rows {
            let ephemeral_pubkey = row.try_get::<Vec<u8>, _>("ephemeral_pubkey")?;
            let ciphertext = row.try_get::<Vec<u8>, _>("ciphertext")?;

            ret.push((ephemeral_pubkey, ciphertext));
        }

        Ok(ret)
    }

    /**
        commitments and notes will be inserted in a single transaction
        so as to ensure that network's state remain consistent.
    */
    pub async fn fill_commitment_and_insert_note(
        &self,
        tx: &IndexedTransact,
    ) -> Result<(), DbError> {
        let mut conn = self.pool.begin().await?;

        sqlx::query(
            "INSERT INTO indexed_txs (signature, slot, tree_key, kind)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (signature) DO NOTHING",
        )
        .bind(tx.signature.as_str())
        .bind(tx.slot as i64)
        .bind(tx.tree_key.as_str())
        .bind(match tx.decoded.kind {
            TransactKind::Sol => "sol",
            TransactKind::Spl => "spl",
        })
        .execute(&mut *conn)
        .await?;

        let commitment_rows = sqlx::query::<sqlx::Postgres>(
            "INSERT INTO commitments (tree_key,commitment) VALUES ($1,$2),($3,$4);",
        )
        .bind(tx.tree_key.as_str())
        .bind(&tx.decoded.output_commitments[0])
        .bind(tx.tree_key.as_str())
        .bind(&tx.decoded.output_commitments[1])
        .execute(&mut *conn)
        .await?;

        let note_rows = sqlx::query::<sqlx::Postgres>(
            "INSERT INTO notes (ephemeral_pubkey,ciphertext) VALUES ($1,$2),($3,$4);",
        )
        .bind(tx.decoded.encrypted_note1.ephemeral_pubkey.as_slice())
        .bind(tx.decoded.encrypted_note1.ciphertext.as_slice())
        .bind(tx.decoded.encrypted_note2.ephemeral_pubkey.as_slice())
        .bind(tx.decoded.encrypted_note2.ciphertext.as_slice())
        .execute(&mut *conn)
        .await?;

        let new_next = tx.curr_index + 2;

        sqlx::query(
            r#"
            INSERT INTO trees (tree_key, next_index) VALUES ($1, $2)
            ON CONFLICT (tree_key) DO UPDATE SET next_index = EXCLUDED.next_index
            "#,
        )
        .bind(tx.tree_key.as_str())
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
}

#[derive(thiserror::Error, Debug)]
pub enum DbError {
    #[error("record not found")]
    NotFound,

    #[error("unique constraint violated on {0}")]
    Duplicate(String),

    #[error("database connection failed")]
    ConnectionFailed(#[source] sqlx::Error),

    #[error("query failed")]
    QueryFailed(#[source] sqlx::Error),
}

impl From<sqlx::Error> for DbError {
    fn from(err: sqlx::Error) -> Self {
        match &err {
            sqlx::Error::RowNotFound => DbError::NotFound,
            sqlx::Error::Database(db_err) if db_err.is_unique_violation() => {
                DbError::Duplicate(db_err.constraint().unwrap_or_default().to_owned())
            }
            _ => DbError::QueryFailed(err),
        }
    }
}

impl From<DbError> for ApiError {
    fn from(err: DbError) -> Self {
        match err {
            DbError::NotFound => ApiError::new(ApiErrorCode::ValueNotFound, "Resource not found"),
            DbError::Duplicate(field) => {
                ApiError::new(ApiErrorCode::DuplicateValue, "Already exists")
                    .with_field(field, "duplicate")
            }
            DbError::ConnectionFailed(_) | DbError::QueryFailed(_) => {
                ApiError::new(ApiErrorCode::DbError, "Internal server error")
            }
        }
    }
}
