use sqlx::PgPool;

pub async fn is_nullifier_spent(pool: &PgPool, nullifier: &[u8; 32]) -> bool {
    let res: Option<(Vec<u8>,)> = sqlx::query_as("SELECT nullifier FROM nullifiers WHERE nullifier = $1")
        .bind(nullifier.as_slice())
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    res.is_some()
}

pub async fn leaf_count(pool: &PgPool, tree_key: &str) -> i64 {
    let row: Option<(i64,)> = sqlx::query_as("SELECT COUNT(*)::BIGINT FROM utxos WHERE tree_key = $1")
        .bind(tree_key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    row.map(|r| r.0).unwrap_or(0)
}
