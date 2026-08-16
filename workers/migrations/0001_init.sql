-- D1 schema for the privacy-cash worker (SQLite).
-- All binary values are stored as hex TEXT to keep D1 bindings simple.

CREATE TABLE IF NOT EXISTS trees (
    tree_key TEXT PRIMARY KEY,
    next_index INTEGER NOT NULL DEFAULT 0,
    root_index INTEGER NOT NULL DEFAULT 0,
    root_history_hex TEXT NOT NULL DEFAULT '',
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tree_levels (
    tree_key TEXT NOT NULL,
    level INTEGER NOT NULL,
    nodes_hex TEXT NOT NULL,
    PRIMARY KEY (tree_key, level)
);

CREATE TABLE IF NOT EXISTS utxos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_key TEXT NOT NULL,
    leaf_index INTEGER NOT NULL,
    commitment_hex TEXT NOT NULL,
    encrypted_output_hex TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot INTEGER NOT NULL,
    ext_amount INTEGER NOT NULL,
    fee INTEGER NOT NULL,
    UNIQUE (tree_key, leaf_index),
    UNIQUE (tree_key, commitment_hex),
    UNIQUE (encrypted_output_hex)
);

CREATE INDEX IF NOT EXISTS idx_utxos_tree_leaf ON utxos (tree_key, leaf_index);

CREATE TABLE IF NOT EXISTS nullifiers (
    nullifier_hex TEXT PRIMARY KEY,
    tree_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_txs (
    signature TEXT PRIMARY KEY,
    slot INTEGER NOT NULL,
    tree_key TEXT NOT NULL,
    kind TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_signature TEXT,
    last_slot INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO indexer_cursor (id, last_signature, last_slot) VALUES (1, NULL, 0);

CREATE TABLE IF NOT EXISTS sync_lock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT,
    ts INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sync_lock (id, token, ts) VALUES (1, NULL, 0);

CREATE TABLE IF NOT EXISTS encrypted_notes (
    wallet_pubkey TEXT PRIMARY KEY,
    ciphertext_hex TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
);
