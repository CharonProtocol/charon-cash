use axum::extract::{Extension, Json};
use serde_json::Value;
use tower_http::request_id::RequestId;

use crate::response::{ApiError, ApiResponse};

#[derive(serde::Serialize)]
pub struct ProveData {
    pub proof_a: String,
    pub proof_b: String,
    pub proof_c: String,
    pub public_signals: Vec<String>,
}

pub async fn prove(
    Extension(req_id): Extension<RequestId>,
    Json(payload): Json<Value>,
) -> ApiResponse<ProveData> {
    let result = tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let proof = privacy_cash_prover::prove_circuit_json(
            &payload,
            &privacy_cash_prover::default_circuit_base(),
        );
        tracing::info!(latency_ms = started.elapsed().as_millis(), "prove");
        proof
    })
    .await;

    match result {
        Ok(Ok(proof)) => ApiResponse::success(
            ProveData {
                proof_a: proof.proof_a,
                proof_b: proof.proof_b,
                proof_c: proof.proof_c,
                public_signals: proof.public_signals,
            },
            req_id,
        ),
        Ok(Err(e)) => ApiResponse::error(
            ApiError::new(
                crate::response::ApiErrorCode::InvalidInput,
                format!("prove failed: {e:#}"),
            ),
            req_id,
        ),
        Err(e) => ApiResponse::error(
            ApiError::new(
                crate::response::ApiErrorCode::BadGateway,
                format!("prove task failed: {e}"),
            ),
            req_id,
        ),
    }
}
