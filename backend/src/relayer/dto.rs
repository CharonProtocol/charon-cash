use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

use crate::relayer::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum TransactKind {
    Sol,
    Spl,
}

impl TransactKind {
    pub fn parse(s: &str) -> AppResult<Self> {
        match s.to_ascii_lowercase().as_str() {
            "sol" => Ok(TransactKind::Sol),
            "spl" => Ok(TransactKind::Spl),
            other => Err(AppError::bad_request(
                "INVALID_KIND",
                format!("kind must be 'sol' or 'spl', got '{other}'"),
            )),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WithdrawRequest {
    pub kind: String,
    pub proof_a: String,
    pub proof_b: String,
    pub proof_c: String,
    pub root: String,
    pub public_amount: String,
    pub ext_data_hash: String,
    pub input_nullifiers: Vec<String>,
    pub output_commitments: Vec<String>,
    pub ext_amount: i64,
    pub fee: u64,
    pub encrypted_output1: String,
    pub encrypted_output2: String,
    /// SOL: recipient wallet. SPL: recipient **token account (ATA)** (hashed on-chain).
    pub recipient: String,
    pub mint: Option<String>,
    /// SPL only: wallet that owns `recipient` ATA (for idempotent ATA create).
    #[serde(default)]
    pub recipient_owner: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TransactInput {
    pub kind: TransactKind,
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub root: [u8; 32],
    pub public_amount: [u8; 32],
    pub ext_data_hash: [u8; 32],
    pub input_nullifiers: [[u8; 32]; 2],
    pub output_commitments: [[u8; 32]; 2],
    pub ext_amount: i64,
    pub fee: u64,
    pub encrypted_output1: Vec<u8>,
    pub encrypted_output2: Vec<u8>,
    pub recipient: Pubkey,
    pub mint: Option<Pubkey>,
    /// SPL: owner of the recipient ATA (optional; used to create ATA if missing).
    pub recipient_owner: Option<Pubkey>,
}

#[derive(Debug, Deserialize)]
pub struct InitializeSplRequest {
    pub mint: String,
    pub max_deposit_amount: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfigRequest {
    pub deposit_fee_rate: Option<u16>,
    pub withdrawal_fee_rate: Option<u16>,
    pub fee_error_margin: Option<u16>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDepositLimitRequest {
    pub new_limit: u64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDepositLimitSplRequest {
    pub mint: String,
    pub new_limit: u64,
}

#[derive(Debug, Deserialize)]
pub struct SubmitRequest {
    pub transaction: String,
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub signature: String,
    pub slot: Option<u64>,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct RelayerInfo {
    pub program_id: String,
    pub fee_recipient: String,
    pub fee_rate_bps: u16,
    pub withdrawal_fee_rate_bps: u16,
    pub fee_error_margin_bps: u16,
    pub supported_mints: Vec<MintFeeInfo>,
}

#[derive(Debug, Serialize)]
pub struct MintFeeInfo {
    pub mint: String,
    pub fee_ata: String,
}

fn strip0x(s: &str) -> &str {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        rest
    } else {
        t
    }
}

fn hex_vec(s: &str, field: &str) -> AppResult<Vec<u8>> {
    hex::decode(strip0x(s))
        .map_err(|e| AppError::bad_request("INVALID_HEX", format!("{field}: {e}")))
}

fn hex_fixed<const N: usize>(s: &str, field: &str) -> AppResult<[u8; N]> {
    let v = hex_vec(s, field)?;
    let len = v.len();
    v.try_into().map_err(|_| {
        AppError::bad_request(
            "INVALID_LENGTH",
            format!("{field}: expected {N} bytes, got {len}"),
        )
    })
}

fn hex32_pair(vals: &[String], field: &str) -> AppResult<[[u8; 32]; 2]> {
    if vals.len() != 2 {
        return Err(AppError::bad_request(
            "INVALID_LENGTH",
            format!("{field}: expected 2 entries, got {}", vals.len()),
        ));
    }
    Ok([hex_fixed::<32>(&vals[0], field)?, hex_fixed::<32>(&vals[1], field)?])
}

fn parse_pubkey(s: &str, field: &str) -> AppResult<Pubkey> {
    Pubkey::from_str(s.trim())
        .map_err(|e| AppError::bad_request("INVALID_PUBKEY", format!("{field}: {e}")))
}

impl WithdrawRequest {
    pub fn into_input(self) -> AppResult<TransactInput> {
        let kind = TransactKind::parse(&self.kind)?;
        let input_nullifiers = hex32_pair(&self.input_nullifiers, "input_nullifiers")?;
        let output_commitments = hex32_pair(&self.output_commitments, "output_commitments")?;
        let recipient = parse_pubkey(&self.recipient, "recipient")?;
        let mint = match kind {
            TransactKind::Sol => None,
            TransactKind::Spl => {
                let m = self
                    .mint
                    .as_deref()
                    .ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl withdraw requires 'mint'"))?;
                Some(parse_pubkey(m, "mint")?)
            }
        };
        Ok(TransactInput {
            kind,
            proof_a: hex_fixed::<64>(&self.proof_a, "proof_a")?,
            proof_b: hex_fixed::<128>(&self.proof_b, "proof_b")?,
            proof_c: hex_fixed::<64>(&self.proof_c, "proof_c")?,
            root: hex_fixed::<32>(&self.root, "root")?,
            public_amount: hex_fixed::<32>(&self.public_amount, "public_amount")?,
            ext_data_hash: hex_fixed::<32>(&self.ext_data_hash, "ext_data_hash")?,
            input_nullifiers,
            output_commitments,
            ext_amount: self.ext_amount,
            fee: self.fee,
            encrypted_output1: hex_vec(&self.encrypted_output1, "encrypted_output1")?,
            encrypted_output2: hex_vec(&self.encrypted_output2, "encrypted_output2")?,
            recipient,
            mint,
            recipient_owner: match self.recipient_owner.as_deref() {
                Some(s) => Some(parse_pubkey(s, "recipient_owner")?),
                None => None,
            },
        })
    }
}

pub fn tree_key_for(kind: TransactKind, mint: Option<&Pubkey>) -> String {
    match kind {
        TransactKind::Sol => crate::indexer::SOL_TREE_KEY.to_string(),
        TransactKind::Spl => mint
            .map(|m| m.to_string())
            .unwrap_or_else(|| "unknown_mint".to_string()),
    }
}
