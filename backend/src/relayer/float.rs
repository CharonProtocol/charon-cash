//! Float monitoring for the hot signing key.
//!
//! The signer pays two nullifier accounts' rent up front on every transact and is
//! only reimbursed the fee in the same transaction, so its balance is working
//! capital, not a gas allowance. If it runs dry, withdrawals and transfers stop, and
//! the only route left for users is the self-relay escape hatch — which costs them
//! their privacy. A low float is therefore a privacy incident, not just an outage,
//! which is why this logs at error level rather than warning.
//!
//! Topping up automatically requires the fee recipient's key. That account is meant
//! to be cold, so the sweep is opt-in: without `RELAYER_FEE_RECIPIENT_KEYPAIR` this
//! only alarms and an operator sweeps by hand.

use std::sync::Arc;
use std::time::Duration;

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
use solana_sdk::transaction::Transaction;

use crate::relayer::error::RelayerResult;
use crate::relayer::send::{confirm, send_with_retry, ConfirmOutcome};
use crate::relayer::state::RelayerState;

const CHECK_INTERVAL: Duration = Duration::from_secs(60);
/// Left behind on a sweep so the fee account stays rent-exempt and cannot be closed.
const FEE_ACCOUNT_RESERVE_LAMPORTS: u64 = 10_000_000;

pub fn spawn(state: RelayerState) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = check_once(&state).await {
                tracing::warn!(error = %e.message, "float check failed");
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check_once(state: &RelayerState) -> RelayerResult<()> {
    let config = &state.config;
    let signer = config.signer.pubkey();
    let balance = state.rpc.get_balance(&signer).await?;

    if balance >= config.min_signer_balance_lamports {
        tracing::debug!(balance, "signer float healthy");
        return Ok(());
    }

    let Some(fee_keypair) = config.fee_recipient_keypair.clone() else {
        tracing::error!(
            %signer,
            balance,
            minimum = config.min_signer_balance_lamports,
            fee_recipient = %config.fee_recipient,
            "SIGNER FLOAT LOW: the relayer cannot keep paying nullifier rent, which will take \
             withdrawals and transfers offline and push users onto the self-relay path. Sweep \
             from the fee recipient to the signer, or set RELAYER_FEE_RECIPIENT_KEYPAIR to \
             automate it."
        );
        return Ok(());
    };

    let fee_balance = state.rpc.get_balance(&config.fee_recipient).await?;
    let available = fee_balance.saturating_sub(FEE_ACCOUNT_RESERVE_LAMPORTS);
    let wanted = config.signer_topup_lamports.saturating_sub(balance);
    let amount = wanted.min(available);

    if amount == 0 {
        tracing::error!(
            balance,
            fee_balance,
            "SIGNER FLOAT LOW and the fee recipient has nothing to sweep; fund the relayer \
             externally or the private paths will start failing"
        );
        return Ok(());
    }

    sweep(state, &fee_keypair, amount).await?;
    tracing::info!(amount, "swept fee revenue into the signer float");
    Ok(())
}

/// `SystemInstruction::Transfer` is variant 2, bincode-encoded as a u32 tag followed
/// by the lamport amount.
fn transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: crate::relayer::chain::SYSTEM_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

async fn sweep(state: &RelayerState, fee_keypair: &Arc<Keypair>, amount: u64) -> RelayerResult<()> {
    let to = state.config.signer.pubkey();
    let ix = transfer(&fee_keypair.pubkey(), &to, amount);
    let blockhash = state.rpc.get_latest_blockhash().await?.blockhash;
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&fee_keypair.pubkey()),
        &[fee_keypair.as_ref()],
        blockhash,
    );
    let bytes = crate::relayer::wire::serialize(&tx)?;
    let signature = send_with_retry(&state.rpc, &bytes, false).await?;
    if let ConfirmOutcome::Failed(reason) = confirm(&state.rpc, &signature).await {
        tracing::error!(%signature, %reason, "float sweep was rejected on-chain");
    }
    Ok(())
}
