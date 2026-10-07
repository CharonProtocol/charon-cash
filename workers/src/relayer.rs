//! Relayer port: validation chain, tx building (legacy + v0), submit,
//! broadcast, and operator instructions — byte-for-byte parity with the VM
//! backend, minus the always-on indexer (replaced by lazy `sync_tree`).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::accounts as acc;
use crate::accounts::create_ata_idempotent_ix;
use crate::dto::{
    AltAccountResponse, BlockhashResponse, InitializeSplRequest, MintFeeInfo, RelayResponse,
    RelayerInfo, SubmitRequest, TransactInput, TransactKind, UpdateConfigRequest,
    UpdateDepositLimitRequest, UpdateDepositLimitSplRequest, WithdrawRequest,
};
use crate::error::{AppError, AppResult};
use crate::instruction as ixenc;
use crate::rpc::sleep_ms;
use crate::solana::alt::parse_alt_addresses;
use crate::solana::b58;
use crate::solana::pubkey::Pubkey;
use crate::solana::wire::{self, AccountMeta, Instruction};
use crate::state::AppState;
use crate::validate;

/// Nullifiers reserved by a submit in progress, with the reservation time. A
/// cancelled request (client disconnect) never runs its release path, so stale
/// entries are evicted on access instead of blocking the note forever.
const IN_FLIGHT_TTL_MS: i64 = 60_000;

fn in_flight() -> &'static Mutex<HashMap<[u8; 32], i64>> {
    static S: OnceLock<Mutex<HashMap<[u8; 32], i64>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn in_flight_insert(set: &mut HashMap<[u8; 32], i64>, keys: &[[u8; 32]]) {
    let now = crate::sync::now_ms();
    set.retain(|_, t| now - *t < IN_FLIGHT_TTL_MS);
    for k in keys {
        set.insert(*k, now);
    }
}

fn in_flight_held(set: &mut HashMap<[u8; 32], i64>, keys: &[[u8; 32]]) -> bool {
    let now = crate::sync::now_ms();
    set.retain(|_, t| now - *t < IN_FLIGHT_TTL_MS);
    keys.iter().any(|k| set.contains_key(k))
}

fn in_flight_remove(set: &mut HashMap<[u8; 32], i64>, keys: &[[u8; 32]]) {
    for k in keys {
        set.remove(k);
    }
}

fn fee_cache() -> &'static Mutex<Option<(u16, u16)>> {
    static S: OnceLock<Mutex<Option<(u16, u16)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// Per-kind CU ceilings: measured transact usage plus headroom (SOL transact
/// ~158k incl. Groth16 verify; SPL ~190k plus idempotent-ATA setup ixs). Admin
/// ops keep the old blanket request. The explicit simulate reports
/// "consumed X of Y" before anything is sent, so an underestimated constant
/// fails loudly at the relayer instead of inflating every tx's priority fee.
const CU_ADMIN: u32 = 1_000_000;
const CU_TRANSACT_SOL: u32 = 200_000;
const CU_TRANSACT_SPL: u32 = 300_000;
const MICRO_LAMPORTS_PER_CU: u64 = 5_000;

fn compute_budget_ixs(cu_limit: u32) -> Vec<Instruction> {
    let cb = acc::compute_budget_program_id();
    let mut limit_data = vec![2u8];
    limit_data.extend_from_slice(&cu_limit.to_le_bytes());
    let mut price_data = vec![3u8];
    price_data.extend_from_slice(&MICRO_LAMPORTS_PER_CU.to_le_bytes());
    vec![
        Instruction { program_id: cb, data: limit_data, accounts: vec![] },
        Instruction { program_id: cb, data: price_data, accounts: vec![] },
    ]
}

/// Blockhashes stay valid ~60-90s; a 20s cached copy saves one RPC round trip
/// per send inside a payroll run, which pins a single isolate. Invalidated on
/// a BlockhashNotFound from the node.
const BLOCKHASH_TTL_MS: i64 = 20_000;

fn blockhash_cache() -> &'static Mutex<Option<([u8; 32], i64)>> {
    static S: OnceLock<Mutex<Option<([u8; 32], i64)>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

async fn fresh_blockhash(state: &AppState) -> AppResult<[u8; 32]> {
    let now = crate::sync::now_ms();
    if let Some((hash, at)) = blockhash_cache().lock().unwrap().as_ref() {
        if now - *at < BLOCKHASH_TTL_MS {
            return Ok(*hash);
        }
    }
    let (hash, _) = state
        .rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| AppError::upstream(format!("get_latest_blockhash: {e}")))?;
    *blockhash_cache().lock().unwrap() = Some((hash, crate::sync::now_ms()));
    Ok(hash)
}

fn invalidate_blockhash() {
    *blockhash_cache().lock().unwrap() = None;
}

fn is_blockhash_miss(err: &AppError) -> bool {
    err.message.contains("BlockhashNotFound")
}

/// Parsed ALT address lists never change for a given table address, so one
/// read per isolate is enough. Failures are never cached, so an evicted
/// epoch heals on the next call.
fn alt_cache() -> &'static Mutex<HashMap<String, Vec<Pubkey>>> {
    static S: OnceLock<Mutex<HashMap<String, Vec<Pubkey>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn alt_addresses(state: &AppState, alt_address: &Pubkey) -> AppResult<Vec<Pubkey>> {
    let key = alt_address.to_string();
    if let Some(hit) = alt_cache().lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let account = state
        .rpc
        .get_account(alt_address)
        .await
        .map_err(|e| AppError::upstream(format!("read ALT {alt_address}: {e}")))?;
    let data = account.ok_or_else(|| {
        AppError::bad_request("INVALID_ALT", format!("ALT {alt_address} not found on chain"))
    })?;
    let addresses = parse_alt_addresses(&data)
        .map_err(|e| AppError::bad_request("INVALID_ALT", format!("alt deserialize: {e}")))?;
    alt_cache().lock().unwrap().insert(key, addresses.clone());
    Ok(addresses)
}

/// 15s confirmation window: poll every 3s; anything longer is "submitted".
async fn wait_confirmed(state: &AppState, sig: &str) -> String {
    for _ in 0..5 {
        sleep_ms(3000).await;
        if let Ok(Some((status, _))) = state.rpc.get_signature_status(sig).await {
            if status == "confirmed" || status == "finalized" {
                return "confirmed".to_string();
            }
        }
    }
    "submitted".to_string()
}

async fn simulate_then_send(state: &AppState, wire_bytes: &[u8]) -> AppResult<String> {
    let (err, logs) = state
        .rpc
        .simulate_transaction(wire_bytes)
        .await
        .map_err(|e| AppError::upstream(format!("simulate: {e}")))?;
    if let Some(err) = err {
        return Err(AppError::bad_request(
            "SIMULATION_FAILED",
            format!("{err} | {}", logs.join(" | ")),
        ));
    }
    // The explicit simulate above already produced readable failure logs, so
    // preflight would re-run the whole Groth16 transact on the node a second time.
    state
        .rpc
        .send_transaction(wire_bytes, true)
        .await
        .map_err(|e| AppError::upstream(format!("send_transaction: {e}")))
}

async fn send_legacy(state: &AppState, ixs: Vec<Instruction>, cu_limit: u32) -> AppResult<String> {
    for attempt in 0..2 {
        if attempt > 0 {
            invalidate_blockhash();
        }
        let blockhash = fresh_blockhash(state).await?;
        let mut all = compute_budget_ixs(cu_limit);
        all.extend(ixs.clone());
        let wire_bytes =
            wire::build_legacy_tx(&state.signer_pubkey(), &all, &blockhash, &state.keypair);
        match simulate_then_send(state, &wire_bytes).await {
            Ok(sig) => return Ok(sig),
            Err(e) if attempt == 0 && is_blockhash_miss(&e) => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!("retry loop returns on the second attempt")
}

async fn send_v0(
    state: &AppState,
    ixs: Vec<Instruction>,
    alt_address: Pubkey,
    cu_limit: u32,
) -> AppResult<String> {
    for attempt in 0..2 {
        if attempt > 0 {
            invalidate_blockhash();
        }
        let blockhash = fresh_blockhash(state).await?;
        let mut all = compute_budget_ixs(cu_limit);
        all.extend(ixs.clone());
        let addresses = alt_addresses(state, &alt_address).await?;

        let wire_bytes = wire::build_v0_tx(
            &state.signer_pubkey(),
            &all,
            &alt_address,
            &addresses,
            &blockhash,
            &state.keypair,
        )
        .map_err(|e| AppError::bad_request("ALT_COMPILE", format!("v0 compile: {e}")))?;

        match simulate_then_send(state, &wire_bytes).await {
            Ok(sig) => return Ok(sig),
            Err(e) if attempt == 0 && is_blockhash_miss(&e) => continue,
            Err(e) => return Err(e),
        }
    }
    unreachable!("retry loop returns on the second attempt")
}

async fn submit(state: &AppState, ixs: Vec<Instruction>) -> AppResult<RelayResponse> {
    let sig = send_legacy(state, ixs, CU_ADMIN).await?;
    let status = wait_confirmed(state, &sig).await;
    Ok(RelayResponse { signature: sig, slot: None, status })
}

/// Gasless relayer-signed submit using a Versioned v0 message that reuses the
/// client's Address Lookup Table (SPL withdrawals overflow a legacy tx).
async fn submit_v0(
    state: &AppState,
    ixs: Vec<Instruction>,
    alt_address: Pubkey,
) -> AppResult<RelayResponse> {
    let sig = send_v0(state, ixs, alt_address, CU_ADMIN).await?;
    let status = wait_confirmed(state, &sig).await;
    Ok(RelayResponse { signature: sig, slot: None, status })
}

async fn fee_rates(state: &AppState) -> AppResult<(u16, u16)> {
    if let Some(cached) = *fee_cache().lock().unwrap() {
        return Ok(cached);
    }
    let (global_config, _) = acc::global_config(&state.program_id);
    let account = state
        .rpc
        .get_account(&global_config)
        .await
        .map_err(|e| AppError::upstream(format!("read global_config: {e}")))?;
    let data = account.ok_or_else(|| {
        AppError::bad_request(
            "GLOBAL_NOT_INITIALIZED",
            "global_config account not initialized; call /api/relayer/initialize first",
        )
    })?;
    if data.len() < 38 {
        return Err(AppError::bad_request(
            "GLOBAL_NOT_INITIALIZED",
            "global_config account not initialized; call /api/relayer/initialize first",
        ));
    }
    let withdrawal_fee_rate_bps = u16::from_le_bytes(data[34..36].try_into().unwrap());
    let fee_error_margin_bps = u16::from_le_bytes(data[36..38].try_into().unwrap());
    let rates = (withdrawal_fee_rate_bps, fee_error_margin_bps);
    *fee_cache().lock().unwrap() = Some(rates);
    Ok(rates)
}

fn build_transact_ix(state: &AppState, t: &TransactInput) -> AppResult<Instruction> {
    let (n0_key, n0_bump) = acc::nullifier0(&state.program_id, &t.input_nullifiers[0]);
    let (n1_key, n1_bump) = acc::nullifier1(&state.program_id, &t.input_nullifiers[1]);
    let sys = acc::system_program_id();

    let accounts = match t.kind {
        TransactKind::Sol => {
            let (tree_account, _) = acc::tree_account_sol(&state.program_id);
            let (tree_token_account, _) = acc::tree_token_account(&state.program_id);
            let (global_config, _) = acc::global_config(&state.program_id);
            vec![
                AccountMeta::new(tree_account, false, true),
                AccountMeta::new(n0_key, false, true),
                AccountMeta::new(n1_key, false, true),
                AccountMeta::new_readonly(sys, false),
                AccountMeta::new_readonly(sys, false),
                AccountMeta::new(tree_token_account, false, true),
                AccountMeta::new_readonly(global_config, false),
                AccountMeta::new(t.recipient, false, true),
                AccountMeta::new(state.fee_recipient, false, true),
                AccountMeta::new(state.signer_pubkey(), true, true),
                AccountMeta::new_readonly(sys, false),
            ]
        }
        TransactKind::Spl => {
            let mint = t
                .mint
                .ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
            let (tree_account, _) = acc::tree_account_spl(&state.program_id, &mint);
            let (global_config, _) = acc::global_config(&state.program_id);
            let signer_token_account = acc::associated_token_address(&state.signer_pubkey(), &mint);
            let tree_ata = acc::associated_token_address(&global_config, &mint);
            let fee_recipient_ata = acc::associated_token_address(&state.fee_recipient, &mint);
            let placeholder = t.recipient_owner.unwrap_or(sys);
            vec![
                AccountMeta::new(tree_account, false, true),
                AccountMeta::new(n0_key, false, true),
                AccountMeta::new(n1_key, false, true),
                AccountMeta::new_readonly(sys, false),
                AccountMeta::new_readonly(sys, false),
                AccountMeta::new_readonly(global_config, false),
                AccountMeta::new(state.signer_pubkey(), true, true),
                AccountMeta::new_readonly(mint, false),
                AccountMeta::new(signer_token_account, false, true),
                AccountMeta::new_readonly(placeholder, false),
                AccountMeta::new(t.recipient, false, true),
                AccountMeta::new(tree_ata, false, true),
                AccountMeta::new(fee_recipient_ata, false, true),
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

    Ok(Instruction { program_id: state.program_id, data, accounts })
}

/// Create recipient + fee ATAs (idempotent) so withdraw SPL can transfer.
fn spl_withdraw_setup_ixs(state: &AppState, t: &TransactInput) -> AppResult<Vec<Instruction>> {
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
    let fee_ata = acc::associated_token_address(&state.fee_recipient, &mint);
    Ok(vec![
        create_ata_idempotent_ix(&state.signer_pubkey(), &t.recipient, &owner, &mint),
        create_ata_idempotent_ix(&state.signer_pubkey(), &fee_ata, &state.fee_recipient, &mint),
    ])
}

fn spl_transfer_fee_ata_ixs(state: &AppState, t: &TransactInput) -> AppResult<Vec<Instruction>> {
    let mint = t
        .mint
        .ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
    let fee_ata = acc::associated_token_address(&state.fee_recipient, &mint);
    Ok(vec![create_ata_idempotent_ix(
        &state.signer_pubkey(),
        &fee_ata,
        &state.fee_recipient,
        &mint,
    )])
}

pub async fn relay_withdraw(state: &AppState, req: WithdrawRequest) -> AppResult<RelayResponse> {
    let t = req.into_input()?;
    validate::assert_is_withdraw_or_transfer(&t, state.min_transfer_fee)?;
    if t.ext_amount == 0 && t.recipient != state.fee_recipient {
        return Err(AppError::bad_request(
            "RECIPIENT_NOT_FEE_RECIPIENT",
            "ext=0 transfers must set recipient to the relayer fee recipient",
        ));
    }

    let spent_sig = match (
        state.store.nullifier_spent_by(&hex::encode(t.input_nullifiers[0])).await,
        state.store.nullifier_spent_by(&hex::encode(t.input_nullifiers[1])).await,
    ) {
        (Ok(Some(sig)), _) | (_, Ok(Some(sig))) => Some(sig),
        (Err(_), Err(_)) | (Ok(None), Err(_)) | (Err(_), Ok(None)) => None,
        (Ok(None), Ok(None)) => None,
    };
    if let Some(sig) = spent_sig {
        return Err(AppError::conflict(
            "NULLIFIER_SPENT",
            format!(
                "one of the input nullifiers has already been spent (by tx {sig})"
            ),
        ));
    }

    // Authoritative root check before any fee/ATA work: a doomed request
    // fails here instead of burning a simulate and a 60s in-flight slot.
    if !chain_root_known(state, t.kind, t.mint.as_ref(), &t.root).await? {
        return Err(AppError::bad_request(
            "UNKNOWN_ROOT",
            "proof root is not in the on-chain root history (tree may have advanced)",
        ));
    }

    let (fee_recipient_key, mint_address) = match t.kind {
        TransactKind::Sol => (state.fee_recipient, acc::sol_address()),
        TransactKind::Spl => {
            let mint = t.mint.ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
            (acc::associated_token_address(&state.fee_recipient, &mint), mint)
        }
    };

    validate::ext_data_hash_matches(&t, &fee_recipient_key.to_bytes(), &mint_address.to_bytes())?;
    validate::public_amount_ok(&t)?;

    let (wfr, fem) = fee_rates(state).await?;
    validate::check_fee(&t, wfr, fem)?;

    let n0 = t.input_nullifiers[0];
    let n1 = t.input_nullifiers[1];
    {
        let mut set = in_flight().lock().unwrap();
        if in_flight_held(&mut set, &[n0, n1]) {
            return Err(AppError::conflict(
                "NULLIFIER_IN_FLIGHT",
                "a withdrawal for one of these nullifiers is already being processed",
            ));
        }
        in_flight_insert(&mut set, &[n0, n1]);
    }

    let ix = build_transact_ix(state, &t)?;
    let mut ixs = Vec::new();
    if t.kind == TransactKind::Spl {
        if t.ext_amount < 0 {
            ixs.extend(spl_withdraw_setup_ixs(state, &t)?);
        } else {
            ixs.extend(spl_transfer_fee_ata_ixs(state, &t)?);
        }
    }
    ixs.push(ix);
    let cu = match t.kind {
        TransactKind::Spl => CU_TRANSACT_SPL,
        TransactKind::Sol => CU_TRANSACT_SOL,
    };
    let sent = match (t.kind, t.alt_address) {
        (TransactKind::Spl, Some(alt)) => send_v0(state, ixs, alt, cu).await,
        _ => send_legacy(state, ixs, cu).await,
    };

    match sent {
        Ok(sig) => {
            // Hand the tx to background indexing instead of syncing inline —
            // the response returns now; main() pumps the queue via wait_until.
            index_queue().lock().unwrap().push(sig.clone());
            Ok(RelayResponse {
                signature: sig,
                slot: None,
                status: "submitted".to_string(),
            })
        }
        Err(e) => {
            let mut set = in_flight().lock().unwrap();
            in_flight_remove(&mut set, &[n0, n1]);
            Err(e)
        }
    }
}

/// Signatures of relayed withdrawals awaiting background indexing, drained by
/// main() after the response. Isolate-level like fee_cache: the queue only
/// needs to survive until the same invocation's main() returns, and main()
/// pumps with its own Arc to the one shared AppState.
fn index_queue() -> &'static Mutex<Vec<String>> {
    static Q: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn drain_index_queue() -> Vec<String> {
    index_queue().lock().unwrap().drain(..).collect()
}

/// Authoritative root check: read the tree PDA's root ring straight from the
/// chain rather than the D1 mirror (which can trail the newest tx by one
/// sync). Mirrors the program's own check — any byte-equal root in its
/// 100-slot history array is accepted. Layout: root_index u8 @12,
/// root_history[100] @848..4048.
async fn chain_root_known(
    state: &AppState,
    kind: TransactKind,
    mint: Option<&Pubkey>,
    root: &[u8; 32],
) -> AppResult<bool> {
    if *root == [0u8; 32] {
        return Ok(false);
    }
    let pda = match kind {
        TransactKind::Sol => acc::tree_account_sol(&state.program_id).0,
        TransactKind::Spl => {
            let mint = mint
                .ok_or_else(|| AppError::bad_request("MISSING_MINT", "spl requires mint"))?;
            acc::tree_account_spl(&state.program_id, mint).0
        }
    };
    let Some(data) = state
        .rpc
        .get_account(&pda)
        .await
        .map_err(|e| AppError::upstream(format!("tree account fetch: {e}")))?
    else {
        return Err(AppError::internal(format!("tree account {pda} missing")));
    };
    if data.len() < 848 + 32 * ROOT_RING_LEN {
        return Err(AppError::internal(format!(
            "tree account {pda} too small: {} bytes",
            data.len()
        )));
    }
    Ok((0..ROOT_RING_LEN).any(|i| data[848 + i * 32..848 + i * 32 + 32] == *root))
}

const ROOT_RING_LEN: usize = 100;

/// Broadcast a client-signed transaction (hex wire bytes, legacy or v0).
/// The relayer holds no user key: it only verifies the tx targets the
/// privacy-cash program (or the ALT program) and forwards it.
pub async fn broadcast(state: &AppState, req: SubmitRequest) -> AppResult<RelayResponse> {
    let bytes = hex::decode(req.transaction.trim())
        .map_err(|e| AppError::bad_request("INVALID_ENCODING", format!("transaction hex: {e}")))?;
    let parsed = wire::parse_tx(&bytes)
        .map_err(|e| AppError::bad_request("INVALID_TRANSACTION", format!("deserialize: {e}")))?;

    assert_targets_program(state, &parsed).await?;

    let sig = state
        .rpc
        .send_transaction(&bytes, state.skip_preflight)
        .await
        .map_err(|e| AppError::upstream(format!("send_transaction: {e}")))?;

    Ok(RelayResponse {
        signature: sig,
        slot: None,
        status: "submitted".to_string(),
    })
}

async fn assert_targets_program(state: &AppState, parsed: &wire::ParsedTx) -> AppResult<()> {
    let mut tables: Vec<Vec<Pubkey>> = Vec::with_capacity(parsed.lookups.len());
    for lookup in &parsed.lookups {
        let account = state
            .rpc
            .get_account(&lookup.account_key)
            .await
            .map_err(|e| AppError::upstream(format!("read ALT {}: {e}", lookup.account_key)))?;
        let data = account.ok_or_else(|| {
            AppError::upstream(format!("ALT {} not found on chain", lookup.account_key))
        })?;
        let addresses = parse_alt_addresses(&data)
            .map_err(|e| AppError::bad_request("INVALID_ALT", format!("alt deserialize: {e}")))?;
        tables.push(addresses);
    }
    let keys = wire::resolve_keys(parsed, &tables)
        .map_err(|e| AppError::bad_request("INVALID_TRANSACTION", e))?;
    let alt_program = acc::alt_program_id();
    let targets_program = parsed.instructions.iter().any(|ix| {
        keys.get(ix.program_id_index as usize)
            .map(|k| *k == state.program_id || *k == alt_program)
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

pub fn info(state: &AppState) -> RelayerInfo {
    let (withdrawal_fee_rate_bps, fee_error_margin_bps) =
        fee_cache().lock().unwrap().unwrap_or((25, 500));
    let supported_mints = state
        .supported_mints
        .iter()
        .map(|m| MintFeeInfo {
            mint: m.to_string(),
            fee_ata: acc::associated_token_address(&state.fee_recipient, m).to_string(),
        })
        .collect::<Vec<_>>();
    RelayerInfo {
        program_id: state.program_id.to_string(),
        fee_recipient: state.fee_recipient.to_string(),
        fee_rate_bps: state.fee_rate_bps,
        withdrawal_fee_rate_bps,
        fee_error_margin_bps,
        min_transfer_fee: state.min_transfer_fee,
        supported_mints,
    }
}

/// Latest blockhash + slot, so the client can build a tx without its own RPC.
pub async fn latest_blockhash(state: &AppState) -> AppResult<BlockhashResponse> {
    let (blockhash, _) = state
        .rpc
        .get_latest_blockhash()
        .await
        .map_err(|e| AppError::upstream(format!("get_latest_blockhash: {e}")))?;
    let slot = state
        .rpc
        .get_slot()
        .await
        .map_err(|e| AppError::upstream(format!("get_slot: {e}")))?;
    Ok(BlockhashResponse { blockhash: b58::encode(&blockhash), slot })
}

/// Raw Address Lookup Table account bytes (hex) so the client can compress
/// an SPL tx without its own RPC. Returns exists=false when not found.
pub async fn alt_account(state: &AppState, address: &Pubkey) -> AppResult<AltAccountResponse> {
    match state.rpc.get_account(address).await {
        Ok(Some(data)) => Ok(AltAccountResponse { exists: true, data_hex: hex::encode(&data) }),
        Ok(None) => Ok(AltAccountResponse { exists: false, data_hex: String::new() }),
        Err(_) => Ok(AltAccountResponse { exists: false, data_hex: String::new() }),
    }
}

pub async fn initialize_default(state: &AppState) -> AppResult<RelayResponse> {
    let (tree_account, tree_bump) = acc::tree_account_sol(&state.program_id);
    let (tree_token_account, tree_token_bump) = acc::tree_token_account(&state.program_id);
    let (global_config, global_bump) = acc::global_config(&state.program_id);
    let data = ixenc::initialize_data(tree_bump, tree_token_bump, global_bump);
    let ixs = vec![Instruction {
        program_id: state.program_id,
        data,
        accounts: vec![
            AccountMeta::new(tree_account, false, true),
            AccountMeta::new(tree_token_account, false, true),
            AccountMeta::new(global_config, false, true),
            AccountMeta::new(state.signer_pubkey(), true, true),
            AccountMeta::new_readonly(acc::system_program_id(), false),
        ],
    }];
    submit(state, ixs).await
}

pub async fn initialize_spl(state: &AppState, req: InitializeSplRequest) -> AppResult<RelayResponse> {
    let mint = Pubkey::parse(req.mint.trim()).ok_or_else(|| {
        AppError::bad_request("INVALID_PUBKEY", "mint: invalid base58 pubkey")
    })?;
    let max_deposit_amount = req.max_deposit_amount.unwrap_or(1_000_000_000_000);
    let (tree_account, tree_bump) = acc::tree_account_spl(&state.program_id, &mint);
    let (global_config, _) = acc::global_config(&state.program_id);
    let data = ixenc::initialize_spl_data(max_deposit_amount, tree_bump);
    let ixs = vec![Instruction {
        program_id: state.program_id,
        data,
        accounts: vec![
            AccountMeta::new(tree_account, false, true),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(global_config, false),
            AccountMeta::new(state.signer_pubkey(), true, true),
            AccountMeta::new_readonly(acc::system_program_id(), false),
        ],
    }];
    submit(state, ixs).await
}

pub async fn update_global_config(state: &AppState, req: UpdateConfigRequest) -> AppResult<RelayResponse> {
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
    let (global_config, _) = acc::global_config(&state.program_id);
    let data = ixenc::update_global_config_data(
        req.deposit_fee_rate.unwrap_or(0),
        req.withdrawal_fee_rate.unwrap_or(0),
        req.fee_error_margin.unwrap_or(0),
        mask,
    );
    let ixs = vec![Instruction {
        program_id: state.program_id,
        data,
        accounts: vec![
            AccountMeta::new(global_config, false, true),
            AccountMeta::new(state.signer_pubkey(), true, true),
        ],
    }];
    let result = submit(state, ixs).await;
    if result.is_ok() {
        *fee_cache().lock().unwrap() = None;
    }
    result
}

pub async fn update_deposit_limit(state: &AppState, req: UpdateDepositLimitRequest) -> AppResult<RelayResponse> {
    let (tree_account, tree_bump) = acc::tree_account_sol(&state.program_id);
    let data = ixenc::update_deposit_limit_data(req.new_limit, tree_bump);
    let ixs = vec![Instruction {
        program_id: state.program_id,
        data,
        accounts: vec![
            AccountMeta::new(tree_account, false, true),
            AccountMeta::new(state.signer_pubkey(), true, true),
        ],
    }];
    submit(state, ixs).await
}

pub async fn update_deposit_limit_spl(
    state: &AppState,
    req: UpdateDepositLimitSplRequest,
) -> AppResult<RelayResponse> {
    let mint = Pubkey::parse(req.mint.trim()).ok_or_else(|| {
        AppError::bad_request("INVALID_PUBKEY", "mint: invalid base58 pubkey")
    })?;
    let (tree_account, tree_bump) = acc::tree_account_spl(&state.program_id, &mint);
    let data = ixenc::update_deposit_limit_spl_data(req.new_limit, tree_bump);
    let ixs = vec![Instruction {
        program_id: state.program_id,
        data,
        accounts: vec![
            AccountMeta::new(tree_account, false, true),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(state.signer_pubkey(), true, true),
        ],
    }];
    submit(state, ixs).await
}
