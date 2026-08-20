//! Worker state assembled once per isolate from Env bindings.

use crate::rpc::Rpc;
use crate::solana::pubkey::Pubkey;
use crate::solana::sign::Keypair;
use crate::store::Store;
use worker::Env;

pub struct AppState {
    pub rpc: Rpc,
    pub store: Store,
    pub program_id: Pubkey,
    pub keypair: Keypair,
    pub fee_recipient: Pubkey,
    pub fee_rate_bps: u16,
    pub min_transfer_fee: u64,
    pub skip_preflight: bool,
    pub supported_mints: Vec<Pubkey>,
    pub admin_password: Option<String>,
}

fn env_str(env: &Env, name: &str) -> Option<String> {
    env.var(name).ok().map(|v| v.to_string())
}

fn env_secret(env: &Env, name: &str) -> Option<String> {
    env.secret(name).ok().map(|v| v.to_string())
}

impl AppState {
    pub fn from_env(env: &Env) -> Result<AppState, String> {
        let rpc_url = env_secret(env, "SOLANA_RPC_URL")
            .ok_or("SOLANA_RPC_URL secret is not set (wrangler secret put SOLANA_RPC_URL)")?;

        let kp_json = env_secret(env, "RELAYER_KEYPAIR_JSON")
            .ok_or("RELAYER_KEYPAIR_JSON secret is not set (wrangler secret put RELAYER_KEYPAIR_JSON)")?;
        let kp_bytes: Vec<u8> = serde_json::from_str(kp_json.trim())
            .map_err(|e| format!("RELAYER_KEYPAIR_JSON must be a JSON byte array: {e}"))?;
        if kp_bytes.len() != 64 {
            return Err(format!(
                "RELAYER_KEYPAIR_JSON must hold 64 bytes (seed||pubkey), got {}",
                kp_bytes.len()
            ));
        }
        let seed: [u8; 32] = kp_bytes[..32]
            .try_into()
            .map_err(|_| "seed slice wrong length".to_string())?;
        let keypair = Keypair::from_seed(seed);

        let program_id = Pubkey::parse(
            &env_str(env, "PROGRAM_ID").unwrap_or_else(|| "9PpZ9iUSCk6fuv4MvFEkN64hd7kkh28GxGLgSUDRZA9V".to_string()),
        )
        .ok_or("PROGRAM_ID is not valid base58")?;

        let signer_pubkey = Pubkey(keypair.pubkey_bytes());
        let fee_recipient = match env_str(env, "RELAYER_FEE_RECIPIENT") {
            Some(s) => Pubkey::parse(s.trim()).ok_or("RELAYER_FEE_RECIPIENT is not valid base58")?,
            None => signer_pubkey,
        };

        let fee_rate_bps = env_str(env, "RELAYER_FEE_RATE_BPS")
            .and_then(|s| s.trim().parse::<u16>().ok())
            .unwrap_or(25);

        let min_transfer_fee = env_str(env, "RELAYER_MIN_TRANSFER_FEE_LAMPORTS")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(10_000);

        let skip_preflight = env_str(env, "RELAYER_SKIP_PREFLIGHT")
            .map(|s| s.trim().eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let supported_mints = env_str(env, "SUPPORTED_MINTS")
            .map(|s| {
                s.split(',')
                    .map(|m| m.trim())
                    .filter(|m| !m.is_empty())
                    .filter_map(Pubkey::parse)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let admin_password = env_secret(env, "ADMIN_PASSWORD").filter(|s| !s.is_empty());

        let db = env
            .d1("DB")
            .map_err(|e| format!("D1 binding 'DB' missing: {e}"))?;

        Ok(AppState {
            rpc: Rpc { url: rpc_url },
            store: Store::new(db),
            program_id,
            keypair,
            fee_recipient,
            fee_rate_bps,
            min_transfer_fee,
            skip_preflight,
            supported_mints,
            admin_password,
        })
    }

    pub fn signer_pubkey(&self) -> Pubkey {
        Pubkey(self.keypair.pubkey_bytes())
    }
}
