use anyhow::{ensure, Result};
use rocksdb::{DBWithThreadMode, Options, SingleThreaded, DB};
use rs_merkle_tree::{hasher::PoseidonHasher, stores::RocksDbStoreV2, MerkleTree, Node};
use std::{collections::HashMap, sync::Arc};

const MERKLE_STORE_PATH: &'static str = "silent_pay_merkle_store.db";

pub type Pool = MerkleTree<PoseidonHasher, RocksDbStoreV2, 26>;

/// Manages one Merkle tree per token mint uses `RocksDB` for storage.
pub struct MerkleManager {
    // Mapping between mint_address and Pool (mint_address --- Pool)
    pool_by_mint: HashMap<String, Pool>,

    // This connection is stored so as to not make multiple connection to same db
    db: Arc<DBWithThreadMode<SingleThreaded>>,
}

impl MerkleManager {
    /// RocksDB is a derived cache. Restore canonical, ordered leaves from Postgres
    /// before the API or indexer can use it, including after an interrupted write.
    pub async fn restore_from_db(&mut self, db: &crate::db::Db) -> Result<()> {
        for tree_key in db.tree_keys().await? {
            let expected = db.next_index(&tree_key).await? as u64;
            let mut next = 0;
            loop {
                let leaves = db.fetch_commitments(next, 1000, &tree_key).await?;
                if leaves.is_empty() { break; }
                next += leaves.len() as u64;
                self.restore_batch(&tree_key, leaves)?;
            }
            ensure!(next == expected, "stored tree {tree_key} has {next} leaves, expected {expected}");
        }
        Ok(())
    }

    fn restore_batch(&mut self, tree_key: &String, leaves: Vec<(u64, Vec<u8>)>) -> Result<()> {
        let tree = self.get_or_create_pool(tree_key);
        let start = tree.num_leaves();
        let mut nodes = Vec::with_capacity(leaves.len());
        for (offset, (index, commitment)) in leaves.into_iter().enumerate() {
            ensure!(index == start + offset as u64, "gap in stored tree {tree_key} at leaf {index}");
            ensure!(commitment.len() == 32, "invalid commitment length at leaf {index}");
            let mut bytes = [0u8; 32];
            bytes.copy_from_slice(&commitment);
            nodes.push(Node::from(bytes));
        }
        tree.add_leaves(&nodes)?;
        Ok(())
    }

    pub async fn new() -> Result<Self> {
        // Rebuild this derived cache from Postgres at startup (see main).
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

        let mut pool_by_mint: HashMap<String, Pool> = HashMap::new();


        Ok(Self { pool_by_mint, db })
    }

    /// Retrieve the `Pool` based on mint_address
    ///
    /// # NOTE
    ///      Shall be used for proof generation on route handler.
    ///
    /// For Indexer refer to `get_or_create_pool`
    pub fn get_pool(&self, mint_address: &String) -> Option<&Pool> {
        let pool = self.pool_by_mint.get(mint_address);

        if pool.is_none() {
            return None;
        }

        pool
    }

    /// Retrieve the `Pool` for a mint, creating it if it doesn't exist yet.
    ///
    /// # NOTE
    ///     For indexer use only, to update a pool's local state.
    ///
    /// For proof generation / route handlers, use `get_pool` instead.
    pub fn get_or_create_pool(&mut self, mint_address: &String) -> &mut Pool {
        let pool_id = self.pool_by_mint.get(mint_address);

        if pool_id.is_none() {
            // create new pool
            let new_pool_id = self.pool_by_mint.len() as u32 + 1;

            let new_token_store = RocksDbStoreV2::new_with_db(self.db.clone(), new_pool_id);
            let new_token_merkle_tree: MerkleTree<PoseidonHasher, RocksDbStoreV2, 26> =
                MerkleTree::new(PoseidonHasher, new_token_store);

            self.pool_by_mint
                .insert(mint_address.clone(), new_token_merkle_tree);

            return self.pool_by_mint.get_mut(mint_address).unwrap();
        }

        self.pool_by_mint.get_mut(mint_address).unwrap()
    }
}

pub fn sol_address() -> String {
    "11111111111111111111111111111112".to_owned()
}


#[cfg(test)]
mod tests {
    use anyhow::Error;
    use rs_merkle_tree::Node;

    use super::*;

    fn test_manager() -> Result<(tempfile::TempDir, MerkleManager), Error> {
        let dir = tempfile::tempdir()?;
        let mut opts = Options::default();
        opts.create_if_missing(true);
        let db = Arc::new(rocksdb::DB::open(&opts, dir.path())?);
        Ok((dir, MerkleManager { pool_by_mint: HashMap::new(), db }))
    }

    fn field_leaves() -> [Node; 100] {
        std::array::from_fn(|i| {
            let mut bytes = [0u8; 32];
            bytes[31] = i as u8 + 1;
            Node::from(bytes)
        })
    }

    #[tokio::test]
    async fn restores_ordered_batches_to_the_same_root() -> Result<(), Error> {
        let (_expected_dir, mut expected) = test_manager()?;
        let (_restored_dir, mut restored) = test_manager()?;
        let key = sol_address();
        let nodes = field_leaves();
        expected.get_or_create_pool(&key).add_leaves(&nodes)?;
        let leaves: Vec<_> = nodes.iter().enumerate()
            .map(|(i, node)| (i as u64, node.as_ref().to_vec())).collect();
        restored.restore_batch(&key, leaves[..40].to_vec())?;
        restored.restore_batch(&key, leaves[40..].to_vec())?;
        assert_eq!(restored.get_pool(&key).unwrap().num_leaves(), 100);
        assert_eq!(restored.get_pool(&key).unwrap().root()?, expected.get_pool(&key).unwrap().root()?);
        Ok(())
    }

    #[tokio::test]
    async fn rejects_missing_or_malformed_stored_leaves() -> Result<(), Error> {
        let (_dir, mut manager) = test_manager()?;
        let key = sol_address();
        assert!(manager.restore_batch(&key, vec![(1, vec![0; 32])]).is_err());
        assert!(manager.restore_batch(&key, vec![(0, vec![0; 31])]).is_err());
        assert_eq!(manager.get_pool(&key).unwrap().num_leaves(), 0);
        Ok(())
    }

    #[tokio::test]
    async fn successfull_insertion_and_retreival_of_nodes_for_single_pool() -> Result<(), Error> {
        let (_dir, mut merkle_manager) = test_manager()?;

        let pool = merkle_manager.get_or_create_pool(&sol_address());

        let nodes = field_leaves();

        pool.add_leaves(&nodes)?;

        assert_eq!(pool.num_leaves(), 100);
        Ok(())
    }
    #[tokio::test]
    async fn multiple_pools_successfully_initialized_and_working() -> Result<(), Error> {
        let (_dir, mut merkle_manager) = test_manager()?;

        let pool1 = "POOL1".to_owned();
        let pool2 = "POOL2".to_owned();
        let pool3 = "POOL3".to_owned();

        let nodes = field_leaves();

        let mut pool1_root = Node::ZERO;
        {
            let pool1_ref = merkle_manager.get_or_create_pool(&pool1);
            pool1_ref.add_leaves(&nodes)?;
            assert_eq!(pool1_ref.num_leaves(), 100);
            pool1_root = pool1_ref.root()?;
        }

        {
            let pool2_ref = merkle_manager.get_or_create_pool(&pool2);
            pool2_ref.add_leaves(&nodes)?;
            assert_eq!(pool2_ref.num_leaves(), 100);
            let pool2_root = pool2_ref.root()?;
            assert_eq!(pool1_root, pool2_root);
        }

        {
            let pool3_ref = merkle_manager.get_or_create_pool(&pool3);
            pool3_ref.add_leaves(&nodes)?;
            assert_eq!(pool3_ref.num_leaves(), 100);
            let pool3_root = pool3_ref.root()?;
            assert_eq!(pool1_root, pool3_root);
        }

        Ok(())
    }
}
