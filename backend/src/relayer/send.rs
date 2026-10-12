//! Simulation, submission and confirmation.
//!
//! Simulation is the last gate before the relayer spends anything, and it is the
//! only step in the validation pipeline that costs an RPC round trip. Everything
//! cheaper runs first so that garbage is rejected without touching the network.

use std::time::Duration;

use solana_sdk::signature::Signature;

use crate::relayer::error::{ErrorCode, RelayerError, RelayerResult};
use crate::relayer::rpc::RpcClient;

const SEND_ATTEMPTS: usize = 5;
const RETRY_DELAY: Duration = Duration::from_millis(900);
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(45);
const CONFIRM_POLL: Duration = Duration::from_millis(500);

/// Refuse to sign anything that does not simulate cleanly. A failed simulation is
/// free; a failed transaction still costs the fee, and the relayer is the one paying.
pub async fn simulate(rpc: &RpcClient, bytes: &[u8]) -> RelayerResult<()> {
    let result = rpc.simulate_transaction(bytes).await?;
    if let Some(err) = result.err {
        let reason = program_reason(&result.logs).unwrap_or_else(|| err.to_string());
        return Err(RelayerError::new(
            ErrorCode::SimulationFailed,
            format!("transaction would fail on-chain: {reason}"),
        )
        .with_logs(result.logs));
    }
    Ok(())
}

/// Pull the most specific line out of the program logs so the client sees the actual
/// rejection rather than a bare "custom program error".
fn program_reason(logs: &[String]) -> Option<String> {
    logs.iter()
        .rev()
        .find(|l| l.contains("Error") || l.contains("failed") || l.contains("insufficient"))
        .map(|l| l.trim().to_string())
}

pub async fn send_with_retry(
    rpc: &RpcClient,
    bytes: &[u8],
    skip_preflight: bool,
) -> RelayerResult<Signature> {
    let mut last_err = String::from("send failed");
    for attempt in 0..SEND_ATTEMPTS {
        match rpc.send_transaction(bytes, skip_preflight).await {
            Ok(signature) => return Ok(signature),
            Err(e) => {
                last_err = e.message;
                if !is_transient(&last_err) {
                    break;
                }
                tracing::warn!(attempt, error = %last_err, "transient send failure, retrying");
                tokio::time::sleep(RETRY_DELAY).await;
            }
        }
    }
    Err(RelayerError::upstream(format!(
        "could not submit transaction: {last_err}"
    )))
}

/// Retrying a rejected transaction just burns money; retrying a dropped one is how
/// it lands. Only the second class is worth a second attempt.
fn is_transient(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("failed to fetch accounts from remote")
        || m.contains("429")
        || m.contains("too many requests")
        || m.contains("timed out")
        || m.contains("timeout")
        || m.contains("connection reset")
        || m.contains("blockhash not found")
}

pub enum ConfirmOutcome {
    Confirmed,
    /// Landed, but the program returned an error.
    Failed(String),
    /// Not observed before the timeout. It may still land, so callers must report
    /// the signature rather than implying failure.
    Unconfirmed,
}

pub async fn confirm(rpc: &RpcClient, signature: &Signature) -> ConfirmOutcome {
    let deadline = tokio::time::Instant::now() + CONFIRM_TIMEOUT;
    while tokio::time::Instant::now() < deadline {
        match rpc.get_signature_status(signature).await {
            Ok(Some(Ok(()))) => return ConfirmOutcome::Confirmed,
            Ok(Some(Err(reason))) => return ConfirmOutcome::Failed(reason),
            Ok(None) => {}
            Err(e) => tracing::debug!(error = %e.message, "status poll failed, retrying"),
        }
        tokio::time::sleep(CONFIRM_POLL).await;
    }
    ConfirmOutcome::Unconfirmed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_classification_separates_drops_from_rejections() {
        assert!(is_transient("Failed to fetch accounts from remote"));
        assert!(is_transient("HTTP status 429 Too Many Requests"));
        assert!(is_transient("Blockhash not found"));
        assert!(!is_transient(
            "Transaction simulation failed: custom program error 0x1"
        ));
    }

    #[test]
    fn program_reason_prefers_the_last_meaningful_log() {
        let logs = vec![
            "Program log: begin".to_string(),
            "Program log: Error: UnknownRoot".to_string(),
            "Program consumed 1234 units".to_string(),
        ];
        assert_eq!(
            program_reason(&logs).unwrap(),
            "Program log: Error: UnknownRoot"
        );
        assert!(program_reason(&["Program log: fine".to_string()]).is_none());
    }
}
