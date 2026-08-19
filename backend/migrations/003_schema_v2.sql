

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
CREATE TABLE IF NOT EXISTS commitments {
    leaf_index  SERIAL INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    commitment  BYTEA NOT NULL UNIQUE
}


-- This table will be filled by indexer.
-- id is added for tracking notes on client side
CREATE TABLE IF NOT EXISTS notes {
    id SERIAL INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    ephemeral_pubkey BYTEA NOT NULL,
    ciphertext       BYTEA NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
}