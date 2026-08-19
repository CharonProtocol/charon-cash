

-- Used for registration of users on the network
-- Required for using the protocol correctly
-- pubkey - ed25519 key
-- ephemeral_key - user's corresponding x25519 key
-- birth_date - represents the merkle_index when user registered for efficieny
CREATE TABLE IF NOT EXISTS users {
   wallet_pubkey       TEXT PRIMARY KEY,
    viewing_pubkey      BYTEA NOT NULL UNIQUE,
    registered_at_index INTEGER NOT NULL
}

-- This table will be filled by indexer.
CREATE TABLE IF NOT EXISTS commitment {
    leaf_index  INTEGER PRIMARY KEY,
    commitment  BYTEA NOT NULL UNIQUE
}


-- This table will be filled by indexer.
CREATE TABLE IF NOT EXISTS notes {
    ephemeral_pubkey BYTEA NOT NULL,
    ciphertext       BYTEA NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
}