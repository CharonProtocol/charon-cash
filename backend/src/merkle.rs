use anyhow::Result;
use rocksdb::{DBWithThreadMode, Options, SingleThreaded, DB};
use rs_merkle_tree::{hasher::PoseidonHasher, stores::RocksDbStoreV2, MerkleTree};
use std::{collections::HashMap, sync::Arc};

const MERKLE_STORE_PATH: &'static str = "silent_pay_merkle_store.db";

pub type Pool = MerkleTree<PoseidonHasher, RocksDbStoreV2, 26>;

/// Manages one Merkle tree per token mint uses `RocksDB` for storage.
pub struct MerkleManager {
    // Mapping between mint_address and pool_id (mint_address --- pool_id)
    mint_to_pool_id: HashMap<String, u32>,
    // Mapping between the pool_id and corresponding merkle tree (pool_id --- MerkleTree)
    pools_by_id: HashMap<u32, Pool>,
    // This connection is stored so as to not make multiple connection to same db
    db: Arc<DBWithThreadMode<SingleThreaded>>,
}

impl MerkleManager {
    pub async fn new() -> Result<Self> {
        // WARNING : Wipes all the data on boot
        if let Err(e) = tokio::fs::remove_dir_all(MERKLE_STORE_PATH).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
        let mut opts = Options::default();

        opts.create_if_missing(true);

        let db = Arc::new(rocksdb::DB::open(&opts, MERKLE_STORE_PATH)?);

        // SOL merkle tree's store with pool_id being = 1
        let sol_store = RocksDbStoreV2::new_with_db(db.clone(), 1);
        let sol_merkle_tree: MerkleTree<PoseidonHasher, RocksDbStoreV2, 26> =
            MerkleTree::new(PoseidonHasher, sol_store);

        let mut mint_to_pool_id: HashMap<String, u32> = HashMap::new();
        let mut pools_by_id: HashMap<u32, Pool> = HashMap::new();

        mint_to_pool_id.insert(sol_address(), 1);
        pools_by_id.insert(1, sol_merkle_tree);

        Ok(Self {
            mint_to_pool_id,
            pools_by_id,
            db,
        })
    }

    /// Retrieve the `Pool` based on mint_address
    ///
    /// # NOTE
    ///      Shall be used for proof generation on route handler.
    ///
    /// For Indexer refer to `get_or_create_pool`
    pub fn get_pool(&self, mint_address: &String) -> Option<&Pool> {
        let pool_id = self.mint_to_pool_id.get(mint_address);

        if pool_id.is_none() {
            return None;
        }

        let pool_id = pool_id.unwrap();

        self.pools_by_id.get(pool_id)
    }

    /// Retrieve the `Pool` for a mint, creating it if it doesn't exist yet.
    ///
    /// # NOTE
    ///     For indexer use only, to update a pool's local state.
    ///
    /// For proof generation / route handlers, use `get_pool` instead.
    pub fn get_or_create_pool(&mut self, mint_address: &String) -> &mut Pool {
        let pool_id = self.mint_to_pool_id.get(mint_address);

        if pool_id.is_none() {
            // create new pool
            let new_pool_id = self.pools_by_id.len() as u32 + 1;

            let new_token_store = RocksDbStoreV2::new_with_db(self.db.clone(), new_pool_id);
            let new_token_merkle_tree: MerkleTree<PoseidonHasher, RocksDbStoreV2, 26> =
                MerkleTree::new(PoseidonHasher, new_token_store);

            self.mint_to_pool_id
                .insert(mint_address.clone(), new_pool_id);
            self.pools_by_id.insert(new_pool_id, new_token_merkle_tree);

            return self.pools_by_id.get_mut(&new_pool_id).unwrap();
        }

        let pool_id = pool_id.unwrap();

        self.pools_by_id.get_mut(pool_id).unwrap()
    }
}

pub fn sol_address() -> String {
    bs58::encode("11111111111111111111111111111112").into_string()
}
