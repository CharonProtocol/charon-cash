use crate::config::Config;
use crate::db::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    /// Available to relayer / merkle routes (program id, fees, RPC, …).
    #[allow(dead_code)]
    pub config: Config,
}
