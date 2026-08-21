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

--- signature has to be base encoded 
CREATE TABLE IF NOT EXISTS indexed_txs (
    signature TEXT PRIMARY KEY,
    slot BIGINT NOT NULL,
    tree_key TEXT NOT NULL,
    kind TEXT NOT NULL
);
