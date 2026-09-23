use anyhow::{anyhow, Context, Result};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use std::str::FromStr;
use std::sync::Arc;

/// Rent-exempt minimum for one `NullifierAccount` (1 byte of data).
///
/// Solana charges `(ACCOUNT_STORAGE_OVERHEAD + data_len) * lamports_per_byte_year
/// * exemption_threshold` = `(128 + 1) * 3480 * 2`. The account is created by
/// `init_nullifier_account` with the transaction signer as payer and is never
/// closed, so this is an unrecoverable cost to whoever signs.
pub const NULLIFIER_RENT_LAMPORTS: u64 = 897_840;

/// A `transact` creates two nullifier PDAs, so this is the floor the fee has to
/// clear before relaying is solvent. Dwarfs the ~5_000 lamport transaction fee.
pub const TRANSACT_RENT_LAMPORTS: u64 = NULLIFIER_RENT_LAMPORTS * 2;

/// Base transaction fee plus the priority fee the SDK's compute-unit price implies.
pub const ESTIMATED_TX_FEE_LAMPORTS: u64 = 7_000;

#[derive(Clone)]
pub struct Config {
    pub bind_addr: String,
    pub rpc_url: String,
    pub program_id: Pubkey,
    /// Hot signing key. Pays the transaction fee and the nullifier rent.
    pub signer: Arc<Keypair>,
    /// Where protocol fees accrue. Must differ from `signer` so revenue is not
    /// sitting in the key that is exposed to the internet.
    pub fee_recipient: Pubkey,
    /// Optional key for the fee recipient, enabling automatic top-ups of the signer.
    /// Leave unset to keep the fee account cold; the relayer then only alarms on a
    /// low float and an operator sweeps manually.
    pub fee_recipient_keypair: Option<Arc<Keypair>>,
    /// Target signer balance after a sweep.
    pub signer_topup_lamports: u64,
    pub skip_preflight: bool,
    /// Added on top of rent + transaction fee when checking whether a request pays
    /// its own way.
    pub fee_margin_lamports: u64,
    /// Warn below this balance; the signer fronts rent and is only reimbursed
    /// per transaction, so it needs an operating float.
    pub min_signer_balance_lamports: u64,
    /// Address Lookup Table used for SPL transacts, which cannot fit inline.
    pub alt_address: Option<Pubkey>,
    pub rate_limit_per_ip_per_min: u32,
    pub rate_limit_global_per_min: u32,
    pub max_body_bytes: usize,
    /// SPL mints the client is told about, so it can pre-derive fee ATAs.
    pub supported_mints: Vec<Pubkey>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let program_id = env_or("PROGRAM_ID", "HoumtJnPvyaavAdDgoWN78PWLSZYvezghc5FM9sEKEyV");
        let signer = load_keypair()?;
        let fee_recipient = match std::env::var("RELAYER_FEE_RECIPIENT").ok() {
            Some(s) if !s.trim().is_empty() => Pubkey::from_str(s.trim())
                .with_context(|| format!("invalid RELAYER_FEE_RECIPIENT: {s}"))?,
            _ => {
                return Err(anyhow!(
                    "RELAYER_FEE_RECIPIENT is required. Point it at a cold account, not the \
                     signing key: the relayer refuses to relay unless the proof commits the fee \
                     to this address, and keeping it separate means revenue is not held by the \
                     hot key."
                ))
            }
        };

        if fee_recipient == signer.pubkey() {
            return Err(anyhow!(
                "RELAYER_FEE_RECIPIENT must not equal the signing key ({}). Fees would accrue \
                 into the hot wallet, which defeats the point of separating them.",
                signer.pubkey()
            ));
        }

        let fee_recipient_keypair = match std::env::var("RELAYER_FEE_RECIPIENT_KEYPAIR").ok() {
            Some(path) if !path.trim().is_empty() => {
                let kp = read_keypair_file(path.trim())?;
                if kp.pubkey() != fee_recipient {
                    return Err(anyhow!(
                        "RELAYER_FEE_RECIPIENT_KEYPAIR is for {} but RELAYER_FEE_RECIPIENT is {}",
                        kp.pubkey(),
                        fee_recipient
                    ));
                }
                Some(Arc::new(kp))
            }
            _ => None,
        };

        let alt_address = match std::env::var("RELAYER_ALT_ADDRESS").ok() {
            Some(s) if !s.trim().is_empty() => Some(
                Pubkey::from_str(s.trim())
                    .with_context(|| format!("invalid RELAYER_ALT_ADDRESS: {s}"))?,
            ),
            _ => None,
        };

        Ok(Self {
            bind_addr: env_or("RELAYER_BIND_ADDR", "0.0.0.0:8081"),
            rpc_url: env_or("SOLANA_RPC_URL", "http://127.0.0.1:8899"),
            program_id: Pubkey::from_str(&program_id)
                .with_context(|| format!("invalid PROGRAM_ID: {program_id}"))?,
            signer,
            fee_recipient,
            fee_recipient_keypair,
            signer_topup_lamports: env_num("RELAYER_SIGNER_TOPUP_LAMPORTS", 500_000_000),
            skip_preflight: env_flag("RELAYER_SKIP_PREFLIGHT", false),
            fee_margin_lamports: env_num("RELAYER_FEE_MARGIN_LAMPORTS", 50_000),
            min_signer_balance_lamports: env_num(
                "RELAYER_MIN_SIGNER_BALANCE_LAMPORTS",
                100_000_000,
            ),
            alt_address,
            rate_limit_per_ip_per_min: env_num("RELAYER_RATE_LIMIT_PER_IP_PER_MIN", 30) as u32,
            rate_limit_global_per_min: env_num("RELAYER_RATE_LIMIT_GLOBAL_PER_MIN", 600) as u32,
            max_body_bytes: env_num("RELAYER_MAX_BODY_BYTES", 256 * 1024) as usize,
            supported_mints: parse_supported_mints(),
        })
    }

    /// Absolute minimum fee a `transact` must carry for the relayer to break even.
    pub fn fee_floor(&self) -> u64 {
        TRANSACT_RENT_LAMPORTS + ESTIMATED_TX_FEE_LAMPORTS + self.fee_margin_lamports
    }
}

fn load_keypair() -> Result<Arc<Keypair>> {
    let path = std::env::var("RELAYER_KEYPAIR").map_err(|_| {
        anyhow!("RELAYER_KEYPAIR is required (path to a Solana JSON keypair file)")
    })?;
    Ok(Arc::new(read_keypair_file(path.trim())?))
}

/// Reads a Solana CLI keypair file (a JSON array of 64 bytes).
fn read_keypair_file(path: &str) -> Result<Keypair> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read keypair file at {path}"))?;
    let bytes: Vec<u8> = serde_json::from_str(&raw)
        .with_context(|| format!("keypair file {path} is not a JSON byte array"))?;
    Keypair::try_from(bytes.as_slice())
        .map_err(|e| anyhow!("keypair file {path} is not a valid keypair: {e}"))
}

fn parse_supported_mints() -> Vec<Pubkey> {
    const DEFAULT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,\
                           Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    env_or("SUPPORTED_MINTS", DEFAULT)
        .split(',')
        .filter(|s| !s.trim().is_empty())
        .filter_map(|s| Pubkey::from_str(s.trim()).ok())
        .collect()
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_num(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_flag(key: &str, default: bool) -> bool {
    match std::env::var(key).ok() {
        Some(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        None => default,
    }
}
