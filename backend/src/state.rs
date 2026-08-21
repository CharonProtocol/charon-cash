use std::sync::Arc;

use crate::config::Config;
use crate::db::Db;
use crate::relayer::Relayer;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Config,
}
