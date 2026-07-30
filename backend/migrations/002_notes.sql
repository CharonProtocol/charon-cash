-- Encrypted note blobs (client-encrypted; the backend never sees plaintext).
-- One ciphertext per wallet. The client encrypts the note set with a key
-- derived from the wallet signature (see sdk EncryptionService), so the server
-- stores only opaque ciphertext it cannot decrypt.
CREATE TABLE IF NOT EXISTS encrypted_notes (
    wallet_pubkey TEXT PRIMARY KEY,
    ciphertext    BYTEA NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
