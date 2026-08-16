use std::collections::HashSet;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;
use solana_sdk::signer::keypair::Keypair;
use solana_sdk::transaction::Transaction;
use solana_rpc_client::api::config::RpcSendTransactionConfig;
use solana_sdk::transaction::VersionedTransaction;
use solana_sdk::message::v0;
use solana_sdk::message::{AddressLookupTableAccount, VersionedMessage};
use solana_address_lookup_table_interface::state::AddressLookupTable;

use crate::config::Config;
use crate::db::Db;
use crate::indexer::decode::decode_transact_ix;
use crate::indexer::types::{
    DecodedTransact, IndexedNullifier, IndexedTransact, IndexedUtxo, SOL_TREE_KEY,
    TransactKind as IdxKind,
};
use crate::relayer::accounts as acc;
use crate::relayer::accounts::create_ata_idempotent_ix;
use crate::relayer::dto::{
    tree_key_for, AltAccountResponse, BlockhashResponse, InitializeSplRequest, MintFeeInfo, RelayResponse,
    RelayerInfo, SubmitRequest, TransactInput, TransactKind, UpdateConfigRequest, UpdateDepositLimitRequest,
    UpdateDepositLimitSplRequest, WithdrawRequest,
};
use crate::relayer::error::{AppError, AppResult};
use crate::relayer::instruction as ixenc;
use crate::relayer::merkle::MerkleMirror;

pub mod accounts;
pub mod dto;
pub mod error;
pub mod instruction;
pub mod merkle;
pub mod queries;
pub mod validate;

pub struct Relayer {
    rpc: Arc<RpcClient>,
    program_id: Pubkey,
    signer: Arc<Keypair>,
    config: Config,
    db: Db,
    mirror: MerkleMirror,
    in_flight: Mutex<HashSet<[u8; 32]>>,
    fee_cache: Mutex<Option<(u16, u16)>>,
    index_lock: tokio::sync::Mutex<()>,
}

impl Relayer {
    pub fn new(rpc: Arc<RpcClient>, signer: Arc<Keypair>, config: Config, db: Db, mirror: MerkleMirror) -> Self {
        let program_id = config.program_id;
        Self {
            rpc,
            program_id,
            signer,
            config,
            db,
            mirror,
            in_flight: Mutex::new(HashSet::new()),
            fee_cache: Mutex::new(None),
            index_lock: tokio::sync::Mutex::new(()),
        }
    }

    pub async fn merkle_state(&self, tree_key: &str) -> AppResult<crate::relayer::merkle::TreeState> {
        self.mirror.state(tree_key).await
    }

    pub async fn merkle_proof(
        &self,
        tree_key: &str,
        leaf_index: u32,
    ) -> AppResult<crate::relayer::merkle::MerklePath> {
        self.mirror.proof(tree_key, leaf_index).await
    }

    pub async fn nullifier_status(&self, nullifier: &[u8; 32]) -> bool {
        queries::is_nullifier_spent(self.db.pool(), nullifier).await
    }

    pub fn info(&self) -> RelayerInfo {
        let (withdrawal_fee_rate_bps, fee_error_margin_bps) =
            self.fee_cache.lock().unwrap().unwrap_or((25, 500));
        let supported_mints = self
            .config
            .supported_mints
            .iter()
            .map(|m| MintFeeInfo {
                mint: m.to_string(),
                fee_ata: acc::associated_token_address(&self.config.relayer_fee_recipient, m).to_string(),
            })
            .collect::<Vec<_>>();
        RelayerInfo {
            program_id: self.program_id.to_string(),
            fee_recipient: self.config.relayer_fee_recipient.to_string(),
            fee_rate_bps: self.config.relayer_fee_rate_bps,
            withdrawal_fee_rate_bps,
            fee_error_margin_bps,
            supported_mints,
        }
    }

    /// Latest blockhash + slot, so the client can build a tx without its own RPC.
    pub async fn latest_blockhash(&self) -> AppResult<BlockhashResponse> {
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(|e| AppError::upstream(format!("get_latest_blockhash: {e}")))?;
        let slot = self
            .rpc
            .get_slot()
            .await
            .map_err(|e| AppError::upstream(format!("get_slot: {e}")))?;
        Ok(BlockhashResponse {
            blockhash: blockhash.to_string(),
            slot,
        })
    }

    /// Raw Address Lookup Table account bytes (hex) so the client can compress
    /// an SPL tx without its own RPC. Returns exists=false when not found.
    pub async fn alt_account(&self, address: &Pubkey) -> AppResult<AltAccountResponse> {
        match self.rpc.get_account(address).await {
            Ok(acct) => Ok(AltAccountResponse {
                exists: true,
                data_hex: hex::encode(&acct.data),
            }),
            // Account not found (or transient RPC error) → tell the client to create one.
            Err(_) => Ok(AltAccountResponse {
                exists: false,
                data_hex: String::new(),
            }),
        }
    }

    pub async fn initialize_default(&self) -> AppResult<RelayResponse> {
        let (tree_account, tree_bump) = acc::tree_account_sol(&self.program_id);
        let (tree_token_account, tree_token_bump) = acc::tree_token_account(&self.program_id);
        let (global_config, global_bump) = acc::global_config(&self.program_id);
        let data = ixenc::initialize_data(tree_bump, tree_token_bump, global_bump);
        let ixs = vec![Instruction {
            program_id: self.program_id,
            data,
            accounts: vec![
                AccountMeta::new(tree_account, false),
                AccountMeta::new(tree_token_account, false),
                AccountMeta::new(global_config, false),
                AccountMeta::new(self.signer.pubkey(), true),
                AccountMeta::new_readonly(acc::system_program_id(), false),
            ],
        }];
        self.submit(ixs).await
    }

    pub async fn initialize_spl(&self, req: InitializeSplRequest) -> AppResult<RelayResponse> {
        let mint = Pubkey::from_str(&req.mint)
            .map_err(|e| AppError::bad_request("INVALID_PUBKEY", format!("mint: {e}")))?;
        let max_deposit_amount = req.max_deposit_amount.unwrap_or(1_000_000_000_000);
        let (tree_account, tree_bump) = acc::tree_account_spl(&self.program_id, &mint);
        let (global_config, _) = acc::global_config(&self.program_id);
        let data = ixenc::initialize_spl_data(max_deposit_amount, tree_bump);
        let ixs = vec![Instruction {
            program_id: self.program_id,
            data,
            accounts: vec![
                AccountMeta::new(tree_account, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new_readonly(global_config, false),
                AccountMeta::new(self.signer.pubkey(), true),
                AccountMeta::new_readonly(acc::system_program_id(), false),
            ],
        }];
        self.submit(ixs).await
    }

    pub async fn update_global_config(&self, req: UpdateConfigRequest) -> AppResult<RelayResponse> {
        let mut mask = 0u8;
        if req.deposit_fee_rate.is_some() {
            mask |= 1;
        }
        if req.withdrawal_fee_rate.is_some() {
            mask |= 2;
        }
        if req.fee_error_margin.is_some() {
            mask |= 4;
        }
        let (global_config, _) = acc::global_config(&self.program_id);
        let data = ixenc::update_global_config_data(
            req.deposit_fee_rate.unwrap_or(0),
            req.withdrawal_fee_rate.unwrap_or(0),
            req.fee_error_margin.unwrap_or(0),
            mask,
        );
        let ixs = vec![Instruction {
            program_id: self.program_id,
            data,
            accounts: vec![
                AccountMeta::new(global_config, false),
                AccountMeta::new(self.signer.pubkey(), true),
            ],
        }];
        let result = self.submit(ixs).await;
        if result.is_ok() {
            *self.fee_cache.lock().unwrap() = None;
        }
        result
    }

    pub async fn update_deposit_limit(&self, req: UpdateDepositLimitRequest) -> AppResult<RelayResponse> {
        let (tree_account, tree_bump) = acc::tree_account_sol(&self.program_id);
        let data = ixenc::update_deposit_limit_data(req.new_limit, tree_bump);
        let ixs = vec![Instruction {
            program_id: self.program_id,
            data,
            accounts: vec![
                AccountMeta::new(tree_account, false),
                AccountMeta::new(self.signer.pubkey(), true),
            ],
        }];
        self.submit(ixs).await
    }

    pub async fn update_deposit_limit_spl(
        &self,
        req: UpdateDepositLimitSplRequest,
    ) -> AppResult<RelayResponse> {
        let mint = Pubkey::from_str(&req.mint)
            .map_err(|e| AppError::bad_request("INVALID_PUBKEY", format!("mint: {e}")))?;
        let (tree_account, tree_bump) = acc::tree_account_spl(&self.program_id, &mint);
        let data = ixenc::update_deposit_limit_spl_data(req.new_limit, tree_bump);
        let ixs = vec![Instruction {
            program_id: self.program_id,
            data,
            accounts: vec![
                AccountMeta::new(tree_account, false),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(self.signer.pubkey(), true),
            ],
        }];
        self.submit(ixs).await
    }

    pub async fn relay_withdraw(&self, req: WithdrawRequest) -> AppResult<RelayResponse> {
        let t = req.into_input()?;
        validate::assert_is_withdraw(&t)?;

        let tree_key = tree_key_for(t.kind, t.mint.as_ref());

        if queries::is_nullifier_spent(self.db.pool(), &t.input_nullifiers[0]).await
            || queries::is_nullifier_spent(self.db.pool(), &t.input_nullifiers[1]).await
        {
            return Err(AppError::conflict(
                "NULLIFIER_SPENT",
                "one of the input nullifiers has already been spent",
            ));
        }

        let (fee_recipient_key, mint_address) = match t.kind {
            TransactKind::Sol => (self.config.relayer_fee_recipient, acc::sol_address()),
            TransactKind::Spl => {
                let mint = t.mint.ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
                (
                    acc::associated_token_address(&self.config.relayer_fee_recipient, &mint),
                    mint,
                )
            }
        };

        let fee_recipient_bytes = fee_recipient_key.to_bytes();
        let mint_address_bytes = mint_address.to_bytes();
        validate::ext_data_hash_matches(&t, &fee_recipient_bytes, &mint_address_bytes)?;
        validate::public_amount_ok(&t)?;

        let (wfr, fem) = self.fee_rates().await?;
        validate::check_fee(&t, wfr, fem)?;

        if !self.mirror.is_known_root(&tree_key, t.root).await? {
            return Err(AppError::bad_request(
                "UNKNOWN_ROOT",
                "proof root is not in the known root history (tree may have advanced)",
            ));
        }

        let n0 = t.input_nullifiers[0];
        let n1 = t.input_nullifiers[1];
        {
            let mut set = self.in_flight.lock().unwrap();
            if set.contains(&n0) || set.contains(&n1) {
                return Err(AppError::conflict(
                    "NULLIFIER_IN_FLIGHT",
                    "a withdrawal for one of these nullifiers is already being processed",
                ));
            }
            set.insert(n0);
            set.insert(n1);
        }

        let ix = self.build_transact_ix(&t)?;
        let mut ixs = Vec::new();
        if t.kind == TransactKind::Spl {
            ixs.extend(self.spl_withdraw_setup_ixs(&t)?);
        }
        ixs.push(ix);
        let result = match (t.kind, t.alt_address) {
            (TransactKind::Spl, Some(alt)) => self.submit_v0(ixs, alt).await,
            _ => self.submit(ixs).await,
        };

        if let Ok(resp) = &result {
            let decoded = DecodedTransact {
                kind: match t.kind {
                    TransactKind::Sol => IdxKind::Sol,
                    TransactKind::Spl => IdxKind::Spl,
                },
                root: t.root,
                public_amount: t.public_amount,
                ext_data_hash: t.ext_data_hash,
                input_nullifiers: t.input_nullifiers,
                output_commitments: t.output_commitments,
                ext_amount: t.ext_amount,
                fee: t.fee,
                encrypted_output1: t.encrypted_output1.clone(),
                encrypted_output2: t.encrypted_output2.clone(),
            };
            if let Err(e) = self.self_index(&resp.signature, decoded, tree_key.clone()).await {
                tracing::warn!(signature = %resp.signature, error = %e.message, "self-index skipped");
            }
        }

        if result.is_err() {
            let mut set = self.in_flight.lock().unwrap();
            set.remove(&n0);
            set.remove(&n1);
        }
        result
    }

    fn build_transact_ix(&self, t: &TransactInput) -> AppResult<Instruction> {
        let (n0_key, n0_bump) = acc::nullifier0(&self.program_id, &t.input_nullifiers[0]);
        let (n1_key, n1_bump) = acc::nullifier1(&self.program_id, &t.input_nullifiers[1]);
        let sys = acc::system_program_id();

        let accounts = match t.kind {
            TransactKind::Sol => {
                let (tree_account, _) = acc::tree_account_sol(&self.program_id);
                let (tree_token_account, _) = acc::tree_token_account(&self.program_id);
                let (global_config, _) = acc::global_config(&self.program_id);
                vec![
                    AccountMeta::new(tree_account, false),
                    AccountMeta::new(n0_key, false),
                    AccountMeta::new(n1_key, false),
                    AccountMeta::new_readonly(sys, false),
                    AccountMeta::new_readonly(sys, false),
                    AccountMeta::new(tree_token_account, false),
                    AccountMeta::new_readonly(global_config, false),
                    AccountMeta::new(t.recipient, false),
                    AccountMeta::new(self.config.relayer_fee_recipient, false),
                    AccountMeta::new(self.signer.pubkey(), true),
                    AccountMeta::new_readonly(sys, false),
                ]
            }
            TransactKind::Spl => {
                let mint = t
                    .mint
                    .ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
                let (tree_account, _) = acc::tree_account_spl(&self.program_id, &mint);
                let (global_config, _) = acc::global_config(&self.program_id);
                let signer_token_account = acc::associated_token_address(&self.signer.pubkey(), &mint);
                let tree_ata = acc::associated_token_address(&global_config, &mint);
                let fee_recipient_ata =
                    acc::associated_token_address(&self.config.relayer_fee_recipient, &mint);
                let placeholder = t.recipient_owner.unwrap_or(sys);
                vec![
                    AccountMeta::new(tree_account, false),
                    AccountMeta::new(n0_key, false),
                    AccountMeta::new(n1_key, false),
                    AccountMeta::new_readonly(sys, false),
                    AccountMeta::new_readonly(sys, false),
                    AccountMeta::new_readonly(global_config, false),
                    AccountMeta::new(self.signer.pubkey(), true),
                    AccountMeta::new_readonly(mint, false),
                    AccountMeta::new(signer_token_account, false),
                    AccountMeta::new_readonly(placeholder, false),
                    AccountMeta::new(t.recipient, false),
                    AccountMeta::new(tree_ata, false),
                    AccountMeta::new(fee_recipient_ata, false),
                    AccountMeta::new_readonly(acc::token_program_id(), false),
                    AccountMeta::new_readonly(acc::associated_token_program_id(), false),
                    AccountMeta::new_readonly(sys, false),
                ]
            }
        };

        let disc = match t.kind {
            TransactKind::Sol => ixenc::DISC_TRANSACT,
            TransactKind::Spl => ixenc::DISC_TRANSACT_SPL,
        };
        let data = ixenc::transact_data(disc, t, n0_bump, n1_bump);

        Ok(Instruction {
            program_id: self.program_id,
            data,
            accounts,
        })
    }

    /// Create recipient + fee ATAs (idempotent) so withdraw SPL can transfer.
    fn spl_withdraw_setup_ixs(&self, t: &TransactInput) -> AppResult<Vec<Instruction>> {
        let mint = t
            .mint
            .ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
        let owner = t.recipient_owner.ok_or_else(|| {
            AppError::bad_request(
                "MISSING_RECIPIENT_OWNER",
                "spl withdraw requires recipient_owner (wallet that owns the recipient ATA)",
            )
        })?;
        let expected_ata = acc::associated_token_address(&owner, &mint);
        if expected_ata != t.recipient {
            return Err(AppError::bad_request(
                "RECIPIENT_ATA_MISMATCH",
                "recipient must be the ATA of recipient_owner for the given mint",
            ));
        }
        let fee_ata = acc::associated_token_address(&self.config.relayer_fee_recipient, &mint);
        Ok(vec![
            create_ata_idempotent_ix(&self.signer.pubkey(), &t.recipient, &owner, &mint),
            create_ata_idempotent_ix(
                &self.signer.pubkey(),
                &fee_ata,
                &self.config.relayer_fee_recipient,
                &mint,
            ),
        ])
    }

    async fn fee_rates(&self) -> AppResult<(u16, u16)> {
        if let Some(cached) = *self.fee_cache.lock().unwrap() {
            return Ok(cached);
        }
        let (global_config, _) = acc::global_config(&self.program_id);
        let account = self
            .rpc
            .get_account(&global_config)
            .await
            .map_err(|e| AppError::upstream(format!("read global_config: {e}")))?;
        if account.data.len() < 38 {
            return Err(AppError::bad_request(
                "GLOBAL_NOT_INITIALIZED",
                "global_config account not initialized; call /api/relayer/initialize first",
            ));
        }
        let withdrawal_fee_rate_bps = u16::from_le_bytes(account.data[34..36].try_into().unwrap());
        let fee_error_margin_bps = u16::from_le_bytes(account.data[36..38].try_into().unwrap());
        let rates = (withdrawal_fee_rate_bps, fee_error_margin_bps);
        *self.fee_cache.lock().unwrap() = Some(rates);
        Ok(rates)
    }

    async fn submit(&self, ixs: Vec<Instruction>) -> AppResult<RelayResponse> {
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(|e| AppError::upstream(format!("get_latest_blockhash: {e}")))?;

        let compute_budget_id =
            Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
        let mut limit_data = vec![2u8];
        limit_data.extend_from_slice(&1_000_000u32.to_le_bytes());
        let mut price_data = vec![3u8];
        price_data.extend_from_slice(&5_000u64.to_le_bytes());
        let mut all = vec![
            Instruction {
                program_id: compute_budget_id,
                data: limit_data,
                accounts: vec![],
            },
            Instruction {
                program_id: compute_budget_id,
                data: price_data,
                accounts: vec![],
            },
        ];
        all.extend(ixs);

        let tx = {
            let signer_keys: Vec<&dyn Signer> = vec![self.signer.as_ref() as &dyn Signer];
            Transaction::new_signed_with_payer(
                &all,
                Some(&self.signer.pubkey()),
                &signer_keys,
                blockhash,
            )
        };

        let sim = self
            .rpc
            .simulate_transaction(&tx)
            .await
            .map_err(|e| AppError::upstream(format!("simulate: {e}")))?;
        let sim = sim.value;
        if let Some(err) = sim.err {
            let logs = sim.logs.unwrap_or_default().join(" | ");
            return Err(AppError::bad_request(
                "SIMULATION_FAILED",
                format!("{err:?} | {logs}"),
            ));
        }

        let sig = self
            .rpc
            .send_transaction(&tx)
            .await
            .map_err(|e| AppError::upstream(format!("send_transaction: {e}")))?;

        let status = match tokio::time::timeout(
            Duration::from_secs(45),
            self.rpc.confirm_transaction(&sig),
        )
        .await
        {
            Ok(Ok(true)) => "confirmed",
            _ => "submitted",
        };

        Ok(RelayResponse {
            signature: sig.to_string(),
            slot: None,
            status: status.to_string(),
        })
    }

    /// Gasless relayer-signed submit using a Versioned v0 message that reuses the
    /// client's Address Lookup Table. SPL withdrawals carry too many accounts for a
    /// legacy 1232-byte transaction, so the relayer compiles a v0 message against
    /// the ALT the client built (ensureAlt) and signs it with the relayer keypair.
    /// Mirrors submit(); SOL stays on the legacy path.
    async fn submit_v0(
        &self,
        ixs: Vec<Instruction>,
        alt_address: Pubkey,
    ) -> AppResult<RelayResponse> {
        let blockhash = self
            .rpc
            .get_latest_blockhash()
            .await
            .map_err(|e| AppError::upstream(format!("get_latest_blockhash: {e}")))?;

        let compute_budget_id =
            Pubkey::from_str("ComputeBudget111111111111111111111111111111").unwrap();
        let mut limit_data = vec![2u8];
        limit_data.extend_from_slice(&1_000_000u32.to_le_bytes());
        let mut price_data = vec![3u8];
        price_data.extend_from_slice(&5_000u64.to_le_bytes());
        let mut all = vec![
            Instruction {
                program_id: compute_budget_id,
                data: limit_data,
                accounts: vec![],
            },
            Instruction {
                program_id: compute_budget_id,
                data: price_data,
                accounts: vec![],
            },
        ];
        all.extend(ixs);

        let account = self
            .rpc
            .get_account(&alt_address)
            .await
            .map_err(|e| AppError::upstream(format!("read ALT {alt_address}: {e}")))?;
        let table = AddressLookupTable::deserialize(&account.data)
            .map_err(|e| AppError::bad_request("INVALID_ALT", format!("alt deserialize: {e}")))?;
        let lookup = AddressLookupTableAccount {
            key: alt_address,
            addresses: table.addresses.to_vec(),
        };
        let message = v0::Message::try_compile(&self.signer.pubkey(), &all, &[lookup], blockhash)
            .map_err(|e| AppError::bad_request("ALT_COMPILE", format!("v0 compile: {e}")))?;
        let vtx = VersionedTransaction::try_new(
            VersionedMessage::V0(message),
            &[self.signer.as_ref() as &dyn Signer],
        )
        .map_err(|e| AppError::bad_request("SIGN_FAILED", format!("v0 sign: {e}")))?;

        let sim = self
            .rpc
            .simulate_transaction(&vtx)
            .await
            .map_err(|e| AppError::upstream(format!("simulate: {e}")))?;
        let sim = sim.value;
        if let Some(err) = sim.err {
            let logs = sim.logs.unwrap_or_default().join(" | ");
            return Err(AppError::bad_request(
                "SIMULATION_FAILED",
                format!("{err:?} | {logs}"),
            ));
        }

        let sig = self
            .rpc
            .send_transaction(&vtx)
            .await
            .map_err(|e| AppError::upstream(format!("send_transaction: {e}")))?;

        let status = match tokio::time::timeout(
            Duration::from_secs(45),
            self.rpc.confirm_transaction(&sig),
        )
        .await
        {
            Ok(Ok(true)) => "confirmed",
            _ => "submitted",
        };

        Ok(RelayResponse {
            signature: sig.to_string(),
            slot: None,
            status: status.to_string(),
        })
    }

    pub async fn broadcast(&self, req: SubmitRequest) -> AppResult<RelayResponse> {
        let bytes = hex::decode(req.transaction.trim())
            .map_err(|e| AppError::bad_request("INVALID_ENCODING", format!("transaction hex: {e}")))?;
        let vtx: VersionedTransaction = bincode::deserialize(&bytes)
            .map_err(|e| AppError::bad_request("INVALID_TRANSACTION", format!("deserialize: {e}")))?;

        self.assert_targets_program(&vtx).await?;

        let config = RpcSendTransactionConfig {
            skip_preflight: self.config.relayer_skip_preflight,
            ..Default::default()
        };
        let sig = self
            .rpc
            .send_transaction_with_config(&vtx, config)
            .await
            .map_err(|e| AppError::upstream(format!("send_transaction: {e}")))?;

        let status = match tokio::time::timeout(
            Duration::from_secs(45),
            self.rpc.confirm_transaction(&sig),
        )
        .await
        {
            Ok(Ok(true)) => "confirmed",
            _ => "submitted",
        };

        if let Ok(Some((data, accounts))) = self.first_program_ix(&vtx).await {
            if let Ok(decoded) = decode_transact_ix(&data) {
                let tk = match decoded.kind {
                    IdxKind::Sol => SOL_TREE_KEY.to_string(),
                    IdxKind::Spl => accounts
                        .get(7)
                        .map(|p| p.to_string())
                        .unwrap_or_else(|| "unknown_mint".to_string()),
                };
                if let Err(e) = self.self_index(&sig.to_string(), decoded, tk).await {
                    tracing::warn!(signature = %sig, error = %e.message, "self-index skipped");
                }
            }
        }

        Ok(RelayResponse {
            signature: sig.to_string(),
            slot: None,
            status: status.to_string(),
        })
    }

    async fn assert_targets_program(&self, vtx: &VersionedTransaction) -> AppResult<()> {
        let keys = self.resolved_keys(vtx).await?;
        let alt_program = solana_address_lookup_table_interface::program::ID;
        let targets_program = vtx.message.instructions().iter().any(|ci| {
            keys.get(ci.program_id_index as usize)
                .map(|k| *k == self.program_id || *k == alt_program)
                .unwrap_or(false)
        });
        if !targets_program {
            return Err(AppError::bad_request(
                "PROGRAM_NOT_ALLOWED",
                "transaction must contain an instruction for the privacy-cash program",
            ));
        }
        Ok(())
    }

    async fn resolved_keys(&self, vtx: &VersionedTransaction) -> AppResult<Vec<Pubkey>> {
        let message = &vtx.message;
        let mut keys: Vec<Pubkey> = message
            .static_account_keys()
            .iter()
            .map(|a| Pubkey::new_from_array(a.to_bytes()))
            .collect();
        if let Some(lookups) = message.address_table_lookups() {
            for lookup in lookups {
                let alt_pubkey = Pubkey::new_from_array(lookup.account_key.to_bytes());
                let account = self
                    .rpc
                    .get_account(&alt_pubkey)
                    .await
                    .map_err(|e| AppError::upstream(format!("read ALT {alt_pubkey}: {e}")))?;
                let table = AddressLookupTable::deserialize(&account.data)
                    .map_err(|e| AppError::bad_request("INVALID_ALT", format!("alt deserialize: {e}")))?;
                for idx in &lookup.writable_indexes {
                    if let Some(k) = table.addresses.get(*idx as usize) {
                        keys.push(*k);
                    }
                }
                for idx in &lookup.readonly_indexes {
                    if let Some(k) = table.addresses.get(*idx as usize) {
                        keys.push(*k);
                    }
                }
            }
        }
        Ok(keys)
    }

    async fn first_program_ix(
        &self,
        vtx: &VersionedTransaction,
    ) -> AppResult<Option<(Vec<u8>, Vec<Pubkey>)>> {
        let keys = self.resolved_keys(vtx).await?;
        for ci in vtx.message.instructions() {
            if keys
                .get(ci.program_id_index as usize)
                .map(|k| *k == self.program_id)
                .unwrap_or(false)
            {
                let accounts = ci
                    .accounts
                    .iter()
                    .filter_map(|i| keys.get(*i as usize).copied())
                    .collect();
                return Ok(Some((ci.data.clone(), accounts)));
            }
        }
        Ok(None)
    }

    async fn self_index(
        &self,
        signature: &str,
        decoded: DecodedTransact,
        tree_key: String,
    ) -> AppResult<()> {
        let slot = self.rpc.get_slot().await.unwrap_or(0);
        let _guard = self.index_lock.lock().await;
        if self.db.has_tx(signature).await? {
            return Ok(());
        }
        let start_index = self.db.next_index(&tree_key).await?;
        let mut utxos = Vec::with_capacity(2);
        for (i, (commitment, encrypted)) in decoded
            .output_commitments
            .iter()
            .zip([&decoded.encrypted_output1, &decoded.encrypted_output2])
            .enumerate()
        {
            utxos.push(IndexedUtxo {
                tree_key: tree_key.clone(),
                leaf_index: start_index + i as u32,
                commitment: *commitment,
                encrypted_output: encrypted.clone(),
                signature: signature.to_string(),
                slot,
                ext_amount: decoded.ext_amount,
                fee: decoded.fee,
            });
        }
        let nullifiers = decoded
            .input_nullifiers
            .iter()
            .map(|n| IndexedNullifier {
                tree_key: tree_key.clone(),
                nullifier: *n,
                signature: signature.to_string(),
                slot,
            })
            .collect();
        let indexed = IndexedTransact {
            signature: signature.to_string(),
            slot,
            tree_key: tree_key.clone(),
            decoded,
            utxos,
            nullifiers,
        };
        if let Err(e) = self.db.insert_transact(&indexed).await {
            tracing::warn!(signature, error = %e, "self-index insert failed");
        }
        Ok(())
    }
}
