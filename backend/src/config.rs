use anyhow::{Context, Result};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub program_id: Pubkey,
    pub yellowstone_grpc_url: String,
    pub yellowstone_x_token: Option<String>,
    pub indexer_reconnect_secs: u64,
    pub supported_mints: Vec<Pubkey>,
    /// Serve `/api/merkle/{tree_key}/proof/{leaf_index}`. Off by default: the request
    /// identifies which leaf the caller owns, and the backend can already attribute
    /// leaves to wallets from public deposits. Development only.
    pub expose_merkle_proof_route: bool,
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

            supported_mints: parse_supported_mints(),
            expose_merkle_proof_route: std::env::var("EXPOSE_MERKLE_PROOF_ROUTE")
                .map(|v| {
                    matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes")
                })
                .unwrap_or(false),
        })
    }

    pub fn reconnect_delay(&self) -> Duration {
        Duration::from_secs(self.indexer_reconnect_secs)
    }
}

fn parse_supported_mints() -> Vec<Pubkey> {
    let default = [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    ];
    let raw = std::env::var("SUPPORTED_MINTS").unwrap_or_else(|_| default.join(","));
    raw.split(',')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|s| Pubkey::from_str(s.trim()).ok())
        .collect()
}
