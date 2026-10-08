//! `POST /api/relayer/transact` — the privacy-critical path.
//!
//! Withdrawals and transfers must not publish the user's wallet. A wallet-signed
//! transaction names the withdrawing wallet as fee payer and signer directly beside
//! the recipient and amount, which undoes the work the ZK proof just did. So for
//! these two operations the relayer signs instead.
//!
//! The relayer accepts the proof and the raw `extData` components, not a pre-signed
//! transaction: the fee payer is part of the signed message, so anything the user
//! signs already commits to the user as payer.
//!
//! What keeps this trust-minimized is `ext_data_hash`. Recipient, amount, fee, fee
//! recipient, mint and both ciphertexts are hashed into a Groth16 public input the
//! program verifies. Recomputing that hash and requiring equality means the
//! transaction we build is provably the one that was proved. The relayer's complete
//! set of powers is refuse, delay, reorder and observe. It cannot steal, redirect,
//! skim or forge.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use solana_sdk::message::{v0, VersionedMessage};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::VersionedTransaction;

use crate::relayer::alt::fetch_lookup_table;
use crate::relayer::build::{
    build_transact_instruction, create_ata_idempotent, set_compute_unit_limit,
    set_compute_unit_price, SplExtras, TransactIxParams,
};
use crate::relayer::chain::{
    derive_ata, derive_spl_tree_account, derive_transact_pdas, fetch_tree_snapshot,
    nullifiers_spent, unknown_root, TREE_ACCOUNT_SEED,
};
use crate::relayer::config::{ESTIMATED_TX_FEE_LAMPORTS, TRANSACT_RENT_LAMPORTS};
use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};
use crate::relayer::extdata::{complete_ext_data_hash, ext_data_hash_matches, ExtData};
use crate::relayer::parse::{
    decode_bounded_hex, mint_hash_bytes, parse_i64, parse_pubkey, parse_u64, ProofPayload,
    MAX_ENCRYPTED_OUTPUT_BYTES,
};
use crate::relayer::send::{confirm, send_with_retry, simulate, ConfirmOutcome};
use crate::relayer::state::RelayerState;

/// Native SOL transactions fit inline; the priority fee is dropped first if the
/// packet is tight.
const MAX_PACKET_BYTES: usize = 1232;
const COMPUTE_UNIT_LIMIT_SOL: u32 = 1_000_000;
const COMPUTE_UNIT_LIMIT_SPL: u32 = 1_400_000;
const COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: u64 = 5_000;

#[derive(Deserialize)]
pub struct TransactRequest {
    pub proof: ProofPayload,
    /// Signed: negative for a withdrawal, zero for a shielded transfer. A positive
    /// value is a deposit, which the relayer will not sign — see `reject_deposit`.
    pub ext_amount: String,
    pub fee: String,
    pub encrypted_output1: String,
    pub encrypted_output2: String,
    /// Payout destination for a withdrawal. For a transfer nothing moves, so the
    /// client sends a neutral address rather than its own wallet.
    pub recipient: String,
    /// The mint as it was hashed into `ext_data_hash` (`1111…2` for native SOL).
    pub mint: String,
    #[serde(default)]
    pub is_spl: bool,
    /// Fee recipient the client committed to. Checked against ours up front purely
    /// so the error is specific; the hash check would catch a mismatch anyway.
    #[serde(default)]
    pub fee_recipient: Option<String>,
    /// SPL only: the token account the payout lands in. Bound by `ext_data_hash`,
    /// so taking it from the client is safe.
    #[serde(default)]
    pub recipient_token_account: Option<String>,
}

#[derive(Serialize)]
pub struct TransactResponse {
    pub signature: String,
    /// What the relayer paid out of its own float for this transaction.
    pub rent_lamports: u64,
    pub fee_lamports: u64,
}

pub async fn transact(
    State(state): State<RelayerState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(req): Json<TransactRequest>,
) -> RelayerResult<Json<TransactResponse>> {
    // Cheapest check first: a flood costs one hash-map lookup, not an RPC call.
    if let Err(e) = state.limiter.check(Some(peer.ip())) {
        state.metrics.record_refused();
        return Err(e);
    }

    match relay(&state, req).await {
        Ok(response) => Ok(Json(response)),
        Err(e) => {
            state.metrics.record_refused();
            Err(e)
        }
    }
}

async fn relay(state: &RelayerState, req: TransactRequest) -> RelayerResult<TransactResponse> {
    let config = &state.config;
    let proof = req.proof.decode()?;
    let ext_amount = parse_i64("ext_amount", &req.ext_amount)?;
    let fee = parse_u64("fee", &req.fee)?;
    let recipient = parse_pubkey("recipient", &req.recipient)?;
    let mint_field = mint_hash_bytes(&req.mint)?;
    let encrypted_output1 = decode_bounded_hex(
        "encrypted_output1",
        &req.encrypted_output1,
        MAX_ENCRYPTED_OUTPUT_BYTES,
    )?;
    let encrypted_output2 = decode_bounded_hex(
        "encrypted_output2",
        &req.encrypted_output2,
        MAX_ENCRYPTED_OUTPUT_BYTES,
    )?;

    reject_deposit(ext_amount)?;

    // The relayer derives every account it cares about. Anything it takes from the
    // client is covered by `ext_data_hash`, which is checked below.
    let fee_recipient = config.fee_recipient;
    let spl = if req.is_spl {
        let mint = parse_pubkey("mint", &req.mint)?;
        let recipient_token_account = match &req.recipient_token_account {
            Some(s) => parse_pubkey("recipient_token_account", s)?,
            None => {
                return Err(RelayerError::invalid(
                    "recipient_token_account is required when is_spl is true",
                ))
            }
        };
        Some(SplExtras {
            mint,
            // The program checks this is owned by the signer with the right mint, so
            // on a relayed transact it has to be the relayer's own token account.
            signer_token_account: derive_ata(&config.signer.pubkey(), &mint),
            recipient_token_account,
            fee_recipient_ata: derive_ata(&fee_recipient, &mint),
        })
    } else {
        None
    };

    // Explicit mismatch beats an opaque hash failure when the client is simply
    // pointed at a different relayer's fee account.
    if let Some(claimed) = &req.fee_recipient {
        let mut claimed = parse_pubkey("fee_recipient", claimed)?;
        if let Some(s) = &spl {
            claimed = derive_ata(&claimed, &s.mint);
        }
        let expected = match &spl {
            Some(s) => s.fee_recipient_ata,
            None => fee_recipient,
        };
        if claimed != expected {
            return Err(RelayerError::new(
                ErrorCode::FeeRecipientMismatch,
                format!(
                    "proof commits the fee to {claimed}, but this relayer only signs for \
                     {expected}. Re-fetch /api/relayer/info and re-prove."
                ),
            ));
        }
    }

    // What the hash covers differs between SOL and SPL: the SPL program hashes the
    // token accounts, not the wallets.
    let (hash_recipient, hash_fee_recipient) = match &spl {
        Some(s) => (s.recipient_token_account, s.fee_recipient_ata),
        None => (recipient, fee_recipient),
    };

    let calculated = complete_ext_data_hash(&ExtData {
        recipient: hash_recipient.to_bytes(),
        ext_amount,
        encrypted_output1: &encrypted_output1,
        encrypted_output2: &encrypted_output2,
        fee,
        fee_recipient: hash_fee_recipient.to_bytes(),
        mint_address: mint_field,
    });
    if !ext_data_hash_matches(&calculated, &proof.ext_data_hash) {
        return Err(RelayerError::new(
            ErrorCode::ExtDataHashMismatch,
            "the submitted recipient, amount, fee, fee recipient, mint or ciphertexts do not \
             hash to the proof's ext_data_hash, so the transaction requested is not the one \
             that was proved",
        ));
    }

    // Solvency. Nullifier rent is ~250x the transaction fee and is never
    // recoverable, so this is the check that decides whether relaying is viable.
    // let floor = config.fee_floor();
    // if fee < floor {
    //     return Err(RelayerError::new(
    //         ErrorCode::FeeTooLow,
    //         format!(
    //             "fee {fee} does not cover this transaction's cost. Two nullifier accounts cost \
    //              {TRANSACT_RENT_LAMPORTS} lamports of unrecoverable rent plus about \
    //              {ESTIMATED_TX_FEE_LAMPORTS} in transaction fees, so the minimum is {floor}."
    //         ),
    //     ));
    // }

    // Claimed for the rest of this function. Two concurrent requests spending the
    // same note would otherwise both pass the spent check and both get paid for.
    let _in_flight = state.claim_nullifiers(proof.input_nullifiers)?;

    let pdas = derive_transact_pdas(
        &config.program_id,
        &proof.input_nullifiers[0],
        &proof.input_nullifiers[1],
    );
    if nullifiers_spent(&state.rpc, &pdas.nullifier0, &pdas.nullifier1).await? {
        return Err(RelayerError::new(
            ErrorCode::NullifierSpent,
            "one of these notes is already spent on-chain; re-sync your notes",
        ));
    }

    // Catch a stale proof before paying to discover it. The history ring holds 100
    // complete roots (one per transact/swap-leg, not per leaf), so a proof built
    // against an old snapshot ages out after ~100 transactions.
    let tree_account = match &spl {
        Some(s) => derive_spl_tree_account(&config.program_id, &s.mint),
        None => Pubkey::find_program_address(&[TREE_ACCOUNT_SEED], &config.program_id).0,
    };
    let snapshot = fetch_tree_snapshot(&state.rpc, &tree_account).await?;
    if !snapshot.roots.contains(&proof.root) {
        return Err(unknown_root(&proof.root, snapshot.next_index));
    }

    let transaction = assemble(
        state,
        &proof,
        ext_amount,
        fee,
        recipient,
        &encrypted_output1,
        &encrypted_output2,
        spl.as_ref(),
    )
    .await?;

    simulate(&state.rpc, &transaction).await?;

    let signature = send_with_retry(&state.rpc, &transaction, config.skip_preflight).await?;
    match confirm(&state.rpc, &signature).await {
        ConfirmOutcome::Confirmed => {}
        ConfirmOutcome::Failed(reason) => {
            state.metrics.record_failed();
            return Err(RelayerError::new(
                ErrorCode::TxFailed,
                format!("transaction {signature} landed but the program rejected it: {reason}"),
            ));
        }
        ConfirmOutcome::Unconfirmed => {
            // The transaction may still land, so report the signature rather than
            // implying it failed and inviting a double-spend attempt.
            tracing::warn!(%signature, "not confirmed before timeout; may still land");
        }
    }

    state
        .metrics
        .record_relayed(fee, TRANSACT_RENT_LAMPORTS, ESTIMATED_TX_FEE_LAMPORTS);

    Ok(TransactResponse {
        signature: signature.to_string(),
        rent_lamports: TRANSACT_RENT_LAMPORTS,
        fee_lamports: fee,
    })
}

/// A deposit's lamports come from `Transfer { from: signer }`, so relaying one
/// would spend the relayer's money. Deposits are also inherently public and
/// attributable, so there is nothing to gain by hiding the payer.
fn reject_deposit(ext_amount: i64) -> RelayerResult<()> {
    if ext_amount > 0 {
        return Err(RelayerError::invalid(
            "deposits are not relayed: the program funds them from the signer, so relaying one \
             would spend the relayer's balance. Sign deposits with your wallet and POST them to \
             /api/relayer/submit.",
        ));
    }
    Ok(())
}

/// Build and sign, returning wire bytes. Bytes rather than a `VersionedTransaction`
/// because everything downstream — sizing, simulation, submission — works on the
/// serialized form, and serializing once avoids any chance of the signed message and
/// the submitted message diverging.
#[allow(clippy::too_many_arguments)]
async fn assemble(
    state: &RelayerState,
    proof: &crate::relayer::build::ProofBytes,
    ext_amount: i64,
    fee: u64,
    recipient: Pubkey,
    encrypted_output1: &[u8],
    encrypted_output2: &[u8],
    spl: Option<&SplExtras>,
) -> RelayerResult<Vec<u8>> {
    let config = &state.config;
    let payer = config.signer.pubkey();

    let params = TransactIxParams {
        program_id: config.program_id,
        signer: payer,
        proof,
        ext_amount,
        fee,
        encrypted_output1,
        encrypted_output2,
        recipient,
        fee_recipient: config.fee_recipient,
        spl: spl.cloned(),
    };
    let transact_ix = build_transact_instruction(&params);

    let blockhash = state.rpc.get_latest_blockhash().await?.blockhash;

    let (limit, lookup_tables) = match spl {
        None => (COMPUTE_UNIT_LIMIT_SOL, Vec::new()),
        Some(_) => {
            let address = config.alt_address.ok_or_else(|| {
                RelayerError::new(
                    ErrorCode::NotConfigured,
                    "this relayer cannot sign SPL transacts: they need an Address Lookup Table to \
                     fit in a packet. Set RELAYER_ALT_ADDRESS.",
                )
            })?;
            (
                COMPUTE_UNIT_LIMIT_SPL,
                vec![fetch_lookup_table(&state.rpc, &address).await?],
            )
        }
    };

    // The relayer is the payer, so any account creation it needs must also be
    // funded by it — the user's wallet is deliberately not in this transaction.
    let mut pre = Vec::new();
    if let Some(spl) = spl {
        pre.push(create_ata_idempotent(&payer, &payer, &spl.mint));
        pre.push(create_ata_idempotent(&payer, &recipient, &spl.mint));
        pre.push(create_ata_idempotent(
            &payer,
            &config.fee_recipient,
            &spl.mint,
        ));
    }

    let sign = |instructions: Vec<solana_sdk::instruction::Instruction>| -> RelayerResult<Vec<u8>> {
        let message = v0::Message::try_compile(&payer, &instructions, &lookup_tables, blockhash)
            .map(VersionedMessage::V0)
            .map_err(|e| RelayerError::internal(format!("cannot compile transaction: {e}")))?;
        let tx = VersionedTransaction::try_new(message, &[config.signer.as_ref()])
            .map_err(|e| RelayerError::internal(format!("cannot sign transaction: {e}")))?;
        crate::relayer::wire::serialize(&tx)
    };

    let with_priority: Vec<_> = pre
        .iter()
        .cloned()
        .chain([
            set_compute_unit_limit(limit),
            set_compute_unit_price(COMPUTE_UNIT_PRICE_MICRO_LAMPORTS),
            transact_ix.clone(),
        ])
        .collect();

    let mut bytes = sign(with_priority)?;
    if bytes.len() > MAX_PACKET_BYTES {
        // Drop the priority fee before giving up. The transaction still lands, just
        // with less scheduling urgency, which beats refusing to relay at all.
        let without_priority: Vec<_> = pre
            .into_iter()
            .chain([set_compute_unit_limit(limit), transact_ix])
            .collect();
        bytes = sign(without_priority)?;
    }

    if bytes.len() > MAX_PACKET_BYTES {
        return Err(RelayerError::internal(format!(
            "transaction is {} bytes, over the {MAX_PACKET_BYTES} limit; the lookup table needs \
             more static accounts",
            bytes.len()
        )));
    }

    Ok(bytes)
}
