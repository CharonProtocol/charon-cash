// use axum::extract::{Path, Query, State};
// use axum::Json;
// use serde::Deserialize;
// use serde_json::{json, Value};

// use crate::relayer::error::{AppError, AppResult};
// use crate::state::AppState;

// #[derive(Debug, Deserialize)]
// pub struct RangeQuery {
//     pub tree_key: String,
//     #[serde(default)]
//     pub start: u64,
//     pub end: Option<u64>,
// }

// /// GET /api/utxos/range?tree_key=sol&start=0&end=1000
// pub async fn range(
//     State(state): State<AppState>,
//     Query(q): Query<RangeQuery>,
// ) -> AppResult<Json<Value>> {
//     if q.tree_key.is_empty() {
//         return Err(AppError::bad_request(
//             "MISSING_TREE_KEY",
//             "tree_key query param is required",
//         ));
//     }
//     let start = q.start;
//     let end = q.end.unwrap_or(start.saturating_add(10_000));
//     if end < start {
//         return Err(AppError::bad_request(
//             "INVALID_RANGE",
//             "end must be >= start",
//         ));
//     }
//     // Cap page size to keep payloads bounded.
//     let end = end.min(start.saturating_add(20_000));

//     let page = state
//         .db
//         .utxos_range(&q.tree_key, start, end)
//         .await
//         .map_err(AppError::from)?;
//     let total = state
//         .db
//         .utxo_count(&q.tree_key)
//         .await
//         .map_err(AppError::from)?;
//     let next_index = state
//         .db
//         .next_index(&q.tree_key)
//         .await
//         .map_err(AppError::from)? as u64;

//     let utxos: Vec<Value> = page
//         .iter()
//         .map(|u| {
//             json!({
//                 "leaf_index": u.leaf_index,
//                 "commitment": hex::encode(&u.commitment),
//                 "encrypted_output_hex": u.encrypted_output_hex,
//                 "signature": u.signature,
//                 "slot": u.slot,
//             })
//         })
//         .collect();

//     Ok(Json(json!({
//         "tree_key": q.tree_key,
//         "start": start,
//         "end": end,
//         "total": total,
//         "next_index": next_index,
//         "has_more": end < next_index,
//         "utxos": utxos,
//     })))
// }

// #[derive(Debug, Deserialize)]
// pub struct CheckQuery {
//     pub tree_key: Option<String>,
// }

// /// GET /api/utxos/check/:hex?tree_key=sol
// pub async fn check(
//     State(state): State<AppState>,
//     Path(hex_out): Path<String>,
//     Query(q): Query<CheckQuery>,
// ) -> AppResult<Json<Value>> {
//     let hex_clean = hex_out
//         .strip_prefix("0x")
//         .or_else(|| hex_out.strip_prefix("0X"))
//         .unwrap_or(&hex_out)
//         .to_ascii_lowercase();
//     if hex_clean.is_empty() || hex_clean.len() % 2 != 0 {
//         return Err(AppError::bad_request(
//             "INVALID_HEX",
//             "encrypted_output_hex must be even-length hex",
//         ));
//     }

//     let found = state
//         .db
//         .utxo_by_encrypted_hex(&hex_clean, q.tree_key.as_deref())
//         .await
//         .map_err(AppError::from)?;

//     Ok(Json(match found {
//         Some(u) => json!({
//             "exists": true,
//             "tree_key": u.tree_key,
//             "leaf_index": u.leaf_index,
//             "commitment": hex::encode(u.commitment),
//             "signature": u.signature,
//             "slot": u.slot,
//         }),
//         None => json!({ "exists": false }),
//     }))
// }
