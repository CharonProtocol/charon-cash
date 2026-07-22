use std::sync::Arc;

use crate::config::Config;
use crate::db::Db;
use crate::relayer::Relayer;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    #[allow(dead_code)]
    pub config: Config,
    pub relayer: Arc<Relayer>,
}
