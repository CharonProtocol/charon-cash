// use axum::extract::{Path, State};
// use axum::Json;
// use serde_json::{json, Value};

// use crate::relayer::error::{AppError, AppResult};
// use crate::state::AppState;

// pub async fn status(
//     State(state): State<AppState>,
//     Path(hash): Path<String>,
// ) -> AppResult<Json<Value>> {
//     let bytes = parse_nullifier(&hash)?;
//     let spent = state.relayer.nullifier_status(&bytes).await;
//     Ok(Json(json!({ "nullifier": hash, "spent": spent })))
// }

// fn parse_nullifier(s: &str) -> AppResult<[u8; 32]> {
//     let t = s.trim();
//     let stripped = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
//     let v = hex::decode(stripped)
//         .map_err(|e| AppError::bad_request("INVALID_HEX", format!("nullifier: {e}")))?;
//     let len = v.len();
//     v.try_into().map_err(|_| {
//         AppError::bad_request(
//             "INVALID_LENGTH",
//             format!("nullifier: expected 32 bytes, got {len}"),
//         )
//     })
// }
