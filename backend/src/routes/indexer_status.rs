use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::indexer::SOL_TREE_KEY;
use crate::state::AppState;

pub async fn indexer_status(State(state): State<AppState>) -> Json<Value> {
    let (last_signature, last_slot) = state.db.get_cursor().await.unwrap_or((None, 0));
    let sol_utxo_count = state.db.utxo_count(SOL_TREE_KEY).await.unwrap_or(0);

    Json(json!({
        "last_signature": last_signature,
        "last_slot": last_slot,
        "sol_utxo_count": sol_utxo_count,
    }))
}
