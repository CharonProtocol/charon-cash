// use axum::extract::{Path, State};
// use axum::Json;

// use crate::relayer::error::AppError;
// use crate::relayer::merkle::{MerklePath, TreeState};
// use crate::state::AppState;

// pub async fn tree_state(
//     State(state): State<AppState>,
//     Path(tree_key): Path<String>,
// ) -> Result<Json<TreeState>, AppError> {
//     Ok(Json(state.relayer.merkle_state(&tree_key).await?))
// }

// pub async fn proof(
//     State(state): State<AppState>,
//     Path((tree_key, leaf_index)): Path<(String, u32)>,
// ) -> Result<Json<MerklePath>, AppError> {
//     Ok(Json(state.relayer.merkle_proof(&tree_key, leaf_index).await?))
// }
