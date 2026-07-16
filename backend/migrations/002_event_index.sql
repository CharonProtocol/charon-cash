-- Leaf indices are now taken from the program's commitment event, and the event's post-append
-- root is persisted so the Merkle mirror can be checked against the chain.

-- Post-append root reported by the program's event (nullable: pre-event rows won't have it).
ALTER TABLE indexed_txs ADD COLUMN IF NOT EXISTS root BYTEA;

-- Drop the UNIQUE(encrypted_output_hex) constraint. A dummy zero-value output legitimately has an
-- empty (or repeated) encrypted blob, so this constraint could abort an otherwise-valid insert and
-- silently drop a transaction — desyncing every later leaf index. (The auto-generated name from
-- the inline `UNIQUE (encrypted_output_hex)` in 001 is utxos_encrypted_output_hex_key.)
ALTER TABLE utxos DROP CONSTRAINT IF EXISTS utxos_encrypted_output_hex_key;

-- Support the client-scan API (bulk pulls by slot) and per-tree nullifier queries.
CREATE INDEX IF NOT EXISTS idx_utxos_slot ON utxos (slot);
CREATE INDEX IF NOT EXISTS idx_nullifiers_tree ON nullifiers (tree_key);
CREATE INDEX IF NOT EXISTS idx_nullifiers_slot ON nullifiers (slot);
