use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// Machine-readable reasons a relay request was refused. Clients branch on these,
/// so treat them as part of the API surface.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Request body was malformed, oversized, or a field failed a shape check.
    InvalidInput,
    /// Hex/base58 decoding failed.
    InvalidEncoding,
    /// Submitted bytes did not deserialize as a Solana transaction.
    InvalidTransaction,
    /// A forwarded transaction touches a program the relayer will not broadcast for.
    ProgramNotAllowed,
    /// The `extData` fields hash to something other than the proof's public input,
    /// so the transaction we would build is not the one that was proved.
    ExtDataHashMismatch,
    /// The proof commits the fee to somebody other than this relayer.
    FeeRecipientMismatch,
    /// The fee does not cover nullifier rent plus the transaction fee.
    FeeTooLow,
    /// One of the nullifiers already has an on-chain marker account.
    NullifierSpent,
    /// We are already relaying a transaction that spends one of these nullifiers.
    NullifierInFlight,
    /// The proof's Merkle root has aged out of the on-chain history ring.
    UnknownRoot,
    /// Pre-flight simulation failed, so we refused to pay for a doomed transaction.
    SimulationFailed,
    /// Too many requests from this caller, or in aggregate.
    RateLimited,
    /// Relayer is missing configuration needed for this request (e.g. an SPL lookup table).
    NotConfigured,
    /// The transaction landed but the program rejected it.
    TxFailed,
    /// Upstream RPC or backend call failed.
    UpstreamError,
    Internal,
}

#[derive(Debug)]
pub struct RelayerError {
    pub code: ErrorCode,
    pub message: String,
    pub logs: Option<Vec<String>>,
}

impl RelayerError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            logs: None,
        }
    }

    pub fn with_logs(mut self, logs: Vec<String>) -> Self {
        self.logs = Some(logs);
        self
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn upstream(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UpstreamError, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    fn status(&self) -> StatusCode {
        match self.code {
            ErrorCode::InvalidInput
            | ErrorCode::InvalidEncoding
            | ErrorCode::InvalidTransaction
            | ErrorCode::ProgramNotAllowed
            | ErrorCode::ExtDataHashMismatch
            | ErrorCode::FeeRecipientMismatch
            | ErrorCode::FeeTooLow
            | ErrorCode::UnknownRoot
            | ErrorCode::SimulationFailed
            | ErrorCode::TxFailed => StatusCode::BAD_REQUEST,
            ErrorCode::NullifierSpent => StatusCode::CONFLICT,
            ErrorCode::NullifierInFlight => StatusCode::CONFLICT,
            ErrorCode::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::NotConfigured => StatusCode::SERVICE_UNAVAILABLE,
            ErrorCode::UpstreamError => StatusCode::BAD_GATEWAY,
            ErrorCode::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    code: ErrorCode,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    logs: Option<Vec<String>>,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

impl IntoResponse for RelayerError {
    fn into_response(self) -> Response {
        let status = self.status();
        tracing::warn!(code = ?self.code, message = %self.message, "relay refused");
        (
            status,
            Json(ErrorEnvelope {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                    logs: self.logs,
                },
            }),
        )
            .into_response()
    }
}

pub type RelayerResult<T> = Result<T, RelayerError>;
