-- Employer UI state sync (run receipts ledger, team roster) keyed per wallet.
-- The worker also self-migrates this table on first use (ensure_ui_table),
-- so applying this file is optional.

CREATE TABLE IF NOT EXISTS ui_docs (
    wallet_pubkey TEXT NOT NULL,
    doc_key TEXT NOT NULL,
    doc TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
    PRIMARY KEY (wallet_pubkey, doc_key)
);
