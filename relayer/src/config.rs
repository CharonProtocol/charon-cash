use anyhow::{Context, Result};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use std::str::FromStr;

pub struct Config {
    pub bind: String,
    pub rpc_url: String,
    /// The relayer's hot wallet: pays fees, submits, and is the fee recipient.
    pub keypair: Keypair,
    /// Must equal the on-chain `GlobalConfig.fee_recipient` (normally the relayer's own account).
    pub fee_recipient: Pubkey,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let keypair_path =
            std::env::var("RELAYER_KEYPAIR").context("RELAYER_KEYPAIR (path to a keypair json) is required")?;
        let keypair = read_keypair_file(&keypair_path)
            .with_context(|| format!("reading relayer keypair from {keypair_path}"))?;

        let fee_recipient = match std::env::var("FEE_RECIPIENT") {
            Ok(s) => Pubkey::from_str(&s).context("invalid FEE_RECIPIENT")?,
            // Default: the relayer earns its own fees.
            Err(_) => keypair.pubkey(),
        };

        Ok(Self {
            bind: std::env::var("BIND").unwrap_or_else(|_| "0.0.0.0:8081".to_string()),
            rpc_url: std::env::var("RPC_URL")
                .unwrap_or_else(|_| "https://api.devnet.solana.com".to_string()),
            keypair,
            fee_recipient,
        })
    }
}

use solana_signer::Signer;

/// Read a Solana CLI keypair file (a JSON array of 64 bytes).
fn read_keypair_file(path: &str) -> Result<Keypair> {
    let bytes = std::fs::read_to_string(path)?;
    let nums: Vec<u8> = serde_json::from_str(&bytes).context("keypair file must be a JSON byte array")?;
    Keypair::try_from(nums.as_slice()).map_err(|e| anyhow::anyhow!("invalid keypair bytes: {e}"))
}
