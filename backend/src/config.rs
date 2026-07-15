
use anyhow::{Context, Result};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub program_id: Pubkey,
    /// Yellowstone / Dragon's Mouth gRPC endpoint, e.g. `https://grpc.example.com:443`
    pub yellowstone_grpc_url: String,
    /// Optional `x-token` auth header for the gRPC provider.
    pub yellowstone_x_token: Option<String>,
    /// Backoff before reconnecting after the stream ends / errors.
    pub indexer_reconnect_secs: u64,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let program_id = std::env::var("PROGRAM_ID")
            .unwrap_or_else(|_| "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV".to_string());

        let yellowstone_x_token = std::env::var("YELLOWSTONE_X_TOKEN")
            .ok()
            .filter(|s| !s.is_empty());

        Ok(Self {
            database_url: std::env::var("DATABASE_URL").context(
                "DATABASE_URL is required (e.g. postgres://user:pass@localhost:5432/privacy_cash)",
            )?,
            program_id: Pubkey::from_str(&program_id)
                .with_context(|| format!("invalid PROGRAM_ID: {program_id}"))?,
            yellowstone_grpc_url: std::env::var("YELLOWSTONE_GRPC_URL").context(
                "YELLOWSTONE_GRPC_URL is required (e.g. https://your-yellowstone-endpoint)",
            )?,
            yellowstone_x_token,
            indexer_reconnect_secs: std::env::var("INDEXER_RECONNECT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(3),
        })
    }

    pub fn reconnect_delay(&self) -> Duration {
        Duration::from_secs(self.indexer_reconnect_secs)
    }
}
