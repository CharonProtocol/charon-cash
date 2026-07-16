//! The shielded wallet file: nothing but the spending key.

use anyhow::{Context, Result};
use pc_core::Keypair as Shielded;
use serde::{Deserialize, Serialize};

pub struct Wallet {
    pub shielded: Shielded,
}

#[derive(Serialize, Deserialize)]
struct WalletFile {
    /// 32-byte shielded private key, hex. This is the whole secret; guard it.
    shielded_privkey: String,
}

impl Wallet {
    pub fn generate() -> Self {
        Self {
            shielded: Shielded::generate(),
        }
    }

    pub fn save(&self, path: &str) -> Result<()> {
        let file = WalletFile {
            shielded_privkey: hex::encode(self.shielded.privkey_be()),
        };
        std::fs::write(path, serde_json::to_string_pretty(&file)?)
            .with_context(|| format!("writing wallet to {path}"))?;
        Ok(())
    }

    pub fn load(path: &str) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading wallet from {path} (run `pcash init` first?)"))?;
        let file: WalletFile = serde_json::from_str(&text)?;
        let bytes = hex::decode(&file.shielded_privkey).context("wallet privkey not hex")?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("shielded privkey must be 32 bytes"))?;
        Ok(Self {
            shielded: Shielded::from_privkey_be(&arr),
        })
    }
}

/// Read a Solana CLI keypair file (JSON array of 64 bytes).
pub fn read_keypair_file(path: &str) -> Result<solana_keypair::Keypair> {
    let text = std::fs::read_to_string(path).with_context(|| format!("reading keypair {path}"))?;
    let nums: Vec<u8> = serde_json::from_str(&text).context("keypair file must be a JSON byte array")?;
    solana_keypair::Keypair::try_from(nums.as_slice())
        .map_err(|e| anyhow::anyhow!("invalid keypair: {e}"))
}
