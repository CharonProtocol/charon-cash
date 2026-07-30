
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
    pub solana_rpc_url: String,
    pub relayer_keypair_path: String,
    pub relayer_fee_recipient: Pubkey,
    pub relayer_fee_rate_bps: u16,
    pub relayer_skip_preflight: bool,
    pub supported_mints: Vec<Pubkey>,
    /// Operator password for the admin/operator endpoints (`ADMIN_PASSWORD` env).
    /// When `None`, operator routes fail closed (403/401).
    pub admin_password: Option<String>,
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
            solana_rpc_url: std::env::var("SOLANA_RPC_URL")
                .context("SOLANA_RPC_URL is required (e.g. https://api.mainnet-beta.solana.com)")?,
            relayer_keypair_path: std::env::var("RELAYER_KEYPAIR")
                .context("RELAYER_KEYPAIR is required (path to solana keypair json)")?,
            relayer_fee_recipient: Pubkey::from_str(
                &std::env::var("RELAYER_FEE_RECIPIENT").unwrap_or_else(|_| {
                    "11111111111111111111111111111111".to_string()
                }),
            )
            .context("invalid RELAYER_FEE_RECIPIENT pubkey")?,
            relayer_fee_rate_bps: std::env::var("RELAYER_FEE_RATE_BPS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(25),
            relayer_skip_preflight: std::env::var("RELAYER_SKIP_PREFLIGHT")
                .ok()
                .map(|v| {
                    matches!(
                        v.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes" | "on"
                    )
                })
                .unwrap_or(false),
            supported_mints: parse_supported_mints(),
            admin_password: std::env::var("ADMIN_PASSWORD").ok().filter(|s| !s.is_empty()),
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
