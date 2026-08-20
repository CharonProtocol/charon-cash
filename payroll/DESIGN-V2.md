# DESIGN-V2 — Shielded recipient notes (payroll v2)

Binding spec for v2. PLAN-V2.md argues from this; conflicts resolve in favor of this file.

## Goal

A treasurer can pay employees with privacy-cash notes instead of public transfers. Each employee note is spendable only by that employee's wallet. On-chain, a payout is just another tree update: no employee address, no amount. The employee discovers and spends the note with the same wallet they use today.

## Non-goals

- No devnet program upgrade from this branch's work without the owner explicitly asking. Local surfpool deploy only.
- No wallet-rotation migration for existing notes (documented risk).
- No changes to the old `backend/` axum port. Workers is the live backend.

## What already exists and must not be redone

- The circuit already commits each output note to an owner pubkey: `commitment = Poseidon(amount, pubkey, blinding, mint)` (`circuits/transaction.circom`). No circuit change, no trusted setup, no verifier change.
- `ext_amount == 0` is a first-class case in the program: `validate_fee` returns Ok (utils.rs:112), funding branches skip both deposit and withdraw paths, fee still pays out (transact.rs:179, transact_spl.rs:200).
- The indexer already stores every `encrypted_output_hex` generically; recipients scanning the tree is how discovery works today for a user's own notes.

## Binding decisions

1. **One program change.** `check_public_amount` (utils.rs:189) rejects `ext_amount == 0` because its guard `ext_amount >= 0 && ext_amount_fr <= fee_fr` is always true at ext 0. Change the guard to `ext_amount > 0`. Nothing else in the program changes. Verified by reading the code directly.
2. **Transfer fee is a flat minimum.** Transfer value is hidden from the relayer, so bps cannot apply. Workers env `RELAYER_MIN_TRANSFER_FEE_LAMPORTS`, default 10000. On-chain `validate_fee` stays permissive for ext 0; the relayer enforces the floor.
3. **ext 0 recipient convention.** The `recipient` account and the ext_data_hash recipient field are `fee_recipient` for transfers, it is the only public payee. SDK sends `recipient = feeRecipient` in the relay body; workers validates that equality for ext 0.
4. **Recipient keys, second signature.** `RECEIVE_SIGN_MESSAGE = "Privacy Money receive key v2"`. x25519 scalar = sha256(signature) clamped to valid scalar; public = x25519 base mult. The existing note keypair derivation is untouched.
5. **Note ciphertext format v3.** `[version 8B = "PCSv3\0\0\0"][ephemeral x25519 pub 32B][iv 12B][tag 16B][ciphertext]`, AES-256-GCM key = HKDF-SHA256(x25519(eph, recipientXPub), salt "privacy-cash-note-v2", info = ephemeral pub). Plaintext unchanged: `"amount|blinding|index|mintAddress"`. v2 format remains readable.
6. **Registry.** Workers D1 table `recipient_keys(wallet_pubkey PK, note_pubkey, enc_pubkey, updated_at)`; routes `PUT /api/recipients` `{wallet, note_pubkey, enc_pubkey, signature}` and `GET /api/recipients/:wallet`. GET returns the row or 404. PUT is authenticated: `signature` is the base64 ed25519 signature of the message `"privacy-cash-recipients-v1\n<wallet>\n<note_pubkey>\n<enc_pubkey>"` made with the wallet key; the backend verifies it before storing (an unauthenticated PUT would let anyone swap keys and redirect notes). `note_pubkey` must be a canonical decimal bn254 field element; `enc_pubkey` must be 64 hex chars.
7. **SDK surface.** `publishRecipientKeys(signer)`, `fetchRecipientKeys(wallet)`, and client methods `transferNoteSOL(recipient, netLamports, opts?)` / `transferNoteSPL(mint, recipient, netRaw, opts?)` returning `{signature, leafIndex, commitment, ...}`. Output 0 is the employee note (amount = net exactly, pubkey = their note pubkey, v3-encrypted). Output 1 is the company change note, encrypted as today. `extAmount = 0`.
8. **Payroll mode.** `mode: "public" | "shielded"` per run. Shielded runs require every employee registered; unregistered rows block the run with a row list. Receipts gain `noteLeafIndex` and `noteCommitment` per entry.
9. **Employee receives with zero new UI for spending.** `syncNotes` + extended decrypt picks up v3 notes automatically once keys exist. A one-toggle "enable private receiving" action calls `publishRecipientKeys`.

## Error matrix additions

| Case | Behavior |
|---|---|
| Employee not registered, shielded run | Run blocked before funding, rows listed with addresses |
| Registry down | Same as relayer-down today: run cannot start, clear message |
| Recipient never scans | Funds wait in the tree, nothing expires |
| ext 0 fee below floor | Workers rejects with `FEE_TOO_LOW`; engine retries then fails the row |
| v3 decrypt by wrong recipient | Skipped like any non-matching ciphertext today |

## Constraints carried from v1

- Branch `payroll` only. Never push, never merge, no remotes.
- No commit trailers (no Co-Authored-By, no Generated-with).
- Never stage `mobile/src/screens/SettingsScreen.tsx` or `mobile/src/store.ts`.
- v2 lifts the payroll-folder-only rule deliberately: `programs/`, `sdk/`, `workers/`, `frontend/`, `payroll/` are all in scope now.
