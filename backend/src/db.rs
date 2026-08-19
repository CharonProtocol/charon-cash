use anyhow::{Context, Result};
use solana_rpc_client::api::response::transaction::containers::Vec;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Row, Transaction};
use tower_http::classify::GrpcCode::Ok;

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

    pub async fn add_user(&self, wallet_pubkey: String, viewing_pubkey: Vec<u8>) -> Result<()> {
        let query =
            sqlx::query("INSERT INTO users (wallet_pubkey, viewing_pubkey) VALUES ($1, $2)")
                .bind(wallet_pubkey)
                .bind(viewing_pubkey)
                .execute(&self.pool)
                .await?;

        Ok(())
    }

    pub async fn get_viewing_key(&self, wallet_pubkey: String) -> Result<Vec<u8>> {
        let query = sqlx::query("SELECT viewing_pubkey FROM users WHERE wallet_pubkey = $1")
            .bind(wallet_pubkey)
            .fetch_one(&self.pool)
            .await?;
        let ret = query.try_get("viewing_pubkey")?;
        Ok(ret)
    }

    /// Fetch commitments from DB starting from leaf_index.
    ///
    /// # Args
    ///     * `leaf_index` : index after which commitments are required
    ///     * `limit` : number of commitments to fetch
    ///
    /// # Returns
    ///     Vector of (leaf_index, commitment).
    ///
    /// Shall be used for building merkle tree on backend
    pub async fn fetch_commitments_from_leaf_index(
        &self,
        leaf_index: u64,
        limit: u16,
    ) -> Result<Vec<(u64, Vec<u8>)>> {
        let rows = sqlx::query::<sqlx::Postgres>(
            "SELECT * FROM commitments WHERE leaf_index >= $1 LIMIT $2",
        )
        .bind(leaf_index)
        .bind(limit)
        .fetch_all(self.pool)
        .await?;

        let mut ret: Vec<(u64, Vec<u8>)> = Vec::new();
        for row in rows {
            let leaf_index = row.try_get("leaf_index")?;
            let commitment = row.try_get("commitment")?;

            ret.push((leaf_index, commitment));
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
    ) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
        let rows = sqlx::query::<sqlx::Postgres>(
            "SELECT (ephemeral_pubkey, ciphertext) FROM notes WHERE id > $1 LIMIT $2",
        )
        .bind(start_from)
        .bind(limit)
        .fetch_all(self.pool)
        .await?;

        let mut ret: Vec<(u64, Vec<u8>)> = Vec::new();
        for row in rows {
            let ephemeral_pubkey = row.try_get("leaf_index")?;
            let ciphertext = row.try_get("commitment")?;

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
        commitments: [[u8; 32]; 2],
        encrypted_note1: Note,
        encrypted_note2: Note,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let commitment_rows =
            sqlx::query::<sqlx::Postgres>("INSERT INTO commitments (commitment) VALUES ($1),($2);")
                .bind(&commitments[1])
                .bind(&commitments[2])
                .fetch_all(&mut *tx)
                .await?;

        let note_rows = sqlx::query::<sqlx::Postgres>(
            "INSERT INTO notes (ephemeral_pubkey,ciphertext) VALUES ($1,$2),($3,$4);",
        )
        .bind(encrypted_note1.ephemeral_pubkey)
        .bind(encrypted_note1.ciphertext)
        .bind(encrypted_note2.ephemeral_pubkey)
        .bind(encrypted_note2.ciphertext)
        .fetch_all(&mut *tx)
        .await?;

        tx.commit().await?;

        Ok(())
    }
}

struct Note {
    ephemeral_pubkey: Vec<u8>,
    ciphertext: Vec<u8>,
}
