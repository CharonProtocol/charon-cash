use std::sync::Arc;

use serde::Serialize;
use tokio::sync::RwLock;

use crate::config::Config;
use crate::db::Db;
use crate::merkle::MerkleManager;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Config,
    pub merkle_manager: Arc<RwLock<MerkleManager>>,
}

#[derive(Clone, Serialize)]
pub struct TreeState {
    pub tree_key: String,
    pub next_leaf_index: u64,
    /// Hex-encoded Poseidon root (`0x…`).
    pub current_root: String,
}
