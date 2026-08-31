
-- Used for registration of users on the network
-- Required for using the protocol correctly
-- wallet_pubkey - ed25519 key
-- viewing_pubkey - user's corresponding x25519 key
-- registered_at - represents the merkle_index when user registered for efficieny
CREATE TABLE IF NOT EXISTS users (
   wallet_pubkey       TEXT PRIMARY KEY,
    viewing_pubkey      BYTEA NOT NULL UNIQUE,
    registered_at TIMESTAMPTZ NOT NULL
);

-- This table will be filled by indexer.
-- tree_key : base encoded mint_address
-- commitment : merkle tree commitment
-- leaf_index : commitment's index in merkle tree
-- updated_at : time at the insertion
CREATE TABLE IF NOT EXISTS commitments (
    leaf_index BIGINT NOT NULL ,
    tree_key TEXT NOT NULL,
    commitment  BYTEA NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tree_key, leaf_index),
    UNIQUE (tree_key, commitment)
);


-- This table will be filled by indexer.
-- id : is added for tracking notes on client side
-- ciphertext : encrypted notes version(8 bytes) + ephemeral_pubkey (32 bytes)
-- + nonce (12 bytes, for AES-GCM)
-- + ciphertext (variable length)
-- + authTag (16 bytes)
-- updated_at : time at the insertion
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    ciphertext       BYTEA NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);