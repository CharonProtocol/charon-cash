-- Initial indexer schema for the Pinocchio privacy-cash program.
-- Stores leaves (commitments + encrypted outputs), not a serialized Merkle tree.

CREATE TABLE IF NOT EXISTS indexer_cursor (
    id INT PRIMARY KEY CHECK (id = 1),
    last_signature TEXT,
    last_slot BIGINT NOT NULL DEFAULT 0
);

INSERT INTO indexer_cursor (id, last_signature, last_slot)
VALUES (1, NULL, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS trees (
    tree_key TEXT PRIMARY KEY,
    next_index BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS utxos (
    id BIGSERIAL PRIMARY KEY,
    tree_key TEXT NOT NULL,
    leaf_index BIGINT NOT NULL,
    commitment BYTEA NOT NULL,
    encrypted_output BYTEA NOT NULL,
    encrypted_output_hex TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot BIGINT NOT NULL,
    ext_amount BIGINT NOT NULL,
    fee BIGINT NOT NULL,
    UNIQUE (tree_key, leaf_index),
    UNIQUE (tree_key, commitment),
    UNIQUE (encrypted_output_hex)
);

CREATE INDEX IF NOT EXISTS idx_utxos_tree_leaf
    ON utxos (tree_key, leaf_index);

CREATE TABLE IF NOT EXISTS nullifiers (
    nullifier BYTEA PRIMARY KEY,
    tree_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    slot BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_txs (
    signature TEXT PRIMARY KEY,
    slot BIGINT NOT NULL,
    tree_key TEXT NOT NULL,
    kind TEXT NOT NULL
);
