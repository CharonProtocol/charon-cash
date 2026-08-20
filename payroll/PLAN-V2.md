# PLAN-V2 — Shielded recipient notes

Argues from payroll/DESIGN-V2.md (the binding spec). Seven tasks, executed sequentially by fresh implementers with per-task review.

## Global constraints (every task)

- Branch `payroll` only. NEVER push, never create remotes, never merge.
- Commit messages: plain one-liners. NO Co-Authored-By, NO "Generated with" trailers.
- NEVER stage or touch `mobile/src/screens/SettingsScreen.tsx` and `mobile/src/store.ts` (intentionally dirty).
- Report deviations honestly; reviewers diff against the brief.
- Match each area's existing code style (workers/relayer Rust: no comments; SDK TS: current style).
- Throwaway scripts go in /tmp, never the repo.

## Interfaces frozen across tasks

- `deriveReceiveKeys(sig: Uint8Array): { x25519Secret: Uint8Array; x25519Public: Uint8Array }` (sdk crypto)
- `encryptUtxoTo(recipientXPub: Uint8Array, utxo: Utxo): Promise<Buffer>` — v3 format (DESIGN-V2 #5)
- `publishRecipientKeys(signer: Signer): Promise<void>` / `fetchRecipientKeys(wallet: PublicKey|string): Promise<{ notePubkey: string; encPubkey: string } | null>` (sdk recipients)
- `transferNoteSOL(recipient, netLamports, opts?): Promise<WithdrawResult & { leafIndex: number; commitment: string }>` and SPL twin
- HTTP: `PUT /api/recipients` body `{wallet, note_pubkey, enc_pubkey, signature}` where `signature` = base64 ed25519 over `"privacy-cash-recipients-v1\n<wallet>\n<note_pubkey>\n<enc_pubkey>"` signed by the wallet key; `GET /api/recipients/:wallet` → row or 404
- Program id stays `9PpZ9iUSCk6fuv4MvFEkN64hd7kkh28GxGLgSUDRZA9V` (surfpool forks devnet; upgrade in place)

## Task V2-1: Program accepts ext 0 transfers

Repo: `programs/privacy-cash/`.

1. `src/utils.rs` `check_public_amount` (~line 189): change `if ext_amount >= 0 && ext_amount_fr <= fee_fr` to `if ext_amount > 0 && ...`. Deposits keep existing behavior (ext > 0 with fee >= ext still rejected); ext 0 now falls through to compute `0 - fee`, matching the client's `(ext - fee) mod FIELD`.
2. Add unit tests next to the function (match the crate's test conventions; add a `#[cfg(test)]` module in utils.rs if none exists): ext=0 fee>0 → true; ext=0 fee=0 → true; ext=5 fee=5 → false (unchanged); ext=-5 fee=1 → true with the matching public amount bytes (reuse existing test helpers if present).
3. Run the crate's existing Rust tests the way the repo does (note: use `cargo +stable` — sqlx 0.9 in the workspace needs Rust >= 1.94; only run this crate's tests, not the whole workspace).
4. Build the program `.so` and deploy to the local surfpool validator at http://localhost:8899. Preferred path: surfpool forks devnet so the program already exists at `9PpZ9i...`; inspect `runbooks/deployment/signers.devnet.tx` for the upgrade authority signer surfpool custodies, then `solana program deploy <so> --program-id <id> --upgrade-authority <from config> -u localhost`. Fallback if authority is not available locally: generate a keypair, patch `declare_id!` is FORBIDDEN (breaks the frozen program id) — instead report BLOCKED with what you found. Verify after deploy: fetch the program account, confirm it changed (compare data length or a before/after hash), and confirm `solana program show` outputs the right id.
5. Do NOT touch devnet. Localhost only.
6. Commit: `fix(program): accept ext=0 shielded transfers in check_public_amount`.

## Task V2-2: SDK crypto v3 (recipient-encrypted notes)

Repo: `sdk/`. Files: `package.json`, `src/crypto.ts`, new `src/crypto.test.ts` if tests live beside sources (follow existing test layout).

1. Add deps if absent: `@noble/curves`, `@noble/hashes` (versions compatible with the rest of the tree; check for existing copies first).
2. `src/constants.ts`: add `RECEIVE_SIGN_MESSAGE = "Privacy Money receive key v2"`, export it from index.
3. `src/crypto.ts`:
   - `deriveReceiveKeys(sig)`: x25519 secret = sha256(sig) reduced to a valid x25519 scalar (clamp per noble docs), public = x25519 secret-to-pub. Pure function, no state.
   - Version marker: existing format uses an 8-byte version prefix (read `EncryptionService` around line 150 for the exact current bytes). v3 uses its own 8-byte prefix, e.g. `"PCSv3\0\0\0"`. Define both as constants.
   - `encryptUtxoTo(recipientXPub, utxo)`: random ephemeral x25519 secret; shared = x25519(eph, recipientXPub); key = HKDF-SHA256(shared, salt "privacy-cash-note-v2", info ephPub, 32 bytes); AES-256-GCM over the same `"amount|blinding|index|mintAddress"` serialization `encryptUtxo` uses today; output `[v3 prefix 8][ephPub 32][iv 12][tag 16][ct]` as Buffer. WebCrypto for AES (mirror the existing implementation).
   - Extend `EncryptionService` to hold the receive secret (set alongside the existing derivation, or lazily) and extend `decryptUtxo` (around line 232): if prefix is v3, unwrap with own receive secret; v2 path unchanged. Wrong-key decrypt must throw the same way it does today (so `syncNotes` skip logic keeps working).
   - `Utxo` (line 49): allow constructing with `pubkey` only (no keypair) — commitment must hash the provided pubkey; `getNullifier`/signing must throw on a keypair-less Utxo (inputs always need keys; outputs never sign).
4. Tests: roundtrip `encryptUtxoTo` → `decryptUtxo` with recipient keys; sender cannot decrypt v3 with own v2 key; commitment of a pubkey-only Utxo equals `poseidon(amount, thatPubkey, blinding, mint)`; existing v2 roundtrip still passes. Poseidon via the existing wasm hasher the SDK already uses.
5. `bun test`/vitest however sdk runs it (check package.json scripts). All green, existing tests unbroken.
6. Commit: `feat(sdk): x25519 recipient keys and v3 note encryption`.

## Task V2-3: Workers registry + transfer validation

Repo: `workers/` (Rust, workers-rs). Style: no comments in these sources.

1. New migration `migrations/0002_recipient_keys.sql`: `CREATE TABLE recipient_keys(wallet_pubkey TEXT PRIMARY KEY, note_pubkey TEXT NOT NULL, enc_pubkey TEXT NOT NULL, updated_at INTEGER NOT NULL);`
2. `src/store.rs`: `put_recipient_keys` (INSERT OR REPLACE, updated_at = current unix seconds) and `get_recipient_keys` (Option row), mirroring existing store method style (~line 276 get_notes).
3. `src/routes.rs` router (~line 184): `PUT /api/recipients` parsing `{wallet, note_pubkey, enc_pubkey}` (validate: wallet is 32B base58, both keys non-empty hex), and `GET /api/recipients/:wallet` returning the row or 404, matching existing handler conventions.
4. `src/validate.rs` `assert_is_withdraw` (~line 8): rename to `assert_is_withdraw_or_transfer`; allow `ext_amount == 0` only when `fee >= min_transfer_fee` (new param wired from state); ext < 0 branch unchanged. Update the call site in `src/relayer.rs` (~line 257).
5. `src/state.rs`: env `RELAYER_MIN_TRANSFER_FEE_LAMPORTS` default 10000.
6. For ext == 0 requests, `relayer.rs` must require `req.recipient == fee_recipient` (error `RECIPIENT_NOT_FEE_RECIPIENT` or nearest existing style) since the fee account is the only public payee. The ext_data_hash recompute path already uses req.recipient, so no change there.
7. Build with the working recipe (worker-build 0.1.14 + wasm-bindgen-cli 0.2.127 if the default toolchain fails; check how it was built before). `wrangler dev` locally with local D1, apply migration, smoke: PUT then GET a row via curl, GET unknown wallet → 404.
8. Commit: `feat(workers): recipient key registry and ext=0 transfer relay`.

## Task V2-4: SDK recipients client + transferNote methods

Repo: `sdk/`.

1. New `src/recipients.ts`: `publishRecipientKeys(signer)` — sign RECEIVE_SIGN_MESSAGE, derive both note pubkey (poseidon of the existing utxo priv derivation is the SENDER's; the recipient's NOTE pubkey is the one from their OWN utxoKeypair, which equals `poseidon(keccak(keccak(sendSig)))`. IMPORTANT: derive the note pubkey from the EXISTING send-signature derivation (utxo keypair pubkey), and the enc keypair from the receive signature. So `publishRecipientKeys` signs BOTH messages: SIGN_MESSAGE for note_pubkey, RECEIVE_SIGN_MESSAGE for enc_pubkey) — PUT to `/api/recipients`. `fetchRecipientKeys(wallet)` — GET, null on 404. Use the existing fetch helper style from `src/merkle.ts`.
2. `src/client.ts` next to `withdrawSOL` (~line 374): `transferNoteSOL(recipient, netLamports, opts?)` and `transferNoteSPL(mint, recipient, netRaw, opts?)`. Both are variants of `withdrawInternal` (line 606) with exactly these deltas:
   - `keys = await fetchRecipientKeys(recipient)`; null → throw `Error("recipient <b58> has not enabled private receiving")`.
   - Fee: `fee = feeFor(gross)` same formula; caller computes gross the same way (net-exact math lives in the payroll app; the SDK method takes NET and gross is derived identically to withdrawInternal but ext = 0: input gross = net + fee + change-source. Concretely: pick notes totaling >= net + fee as today, outputs: [net note to recipient, change], extAmount = 0n, recipientGets concept replaced by output0.amount = net).
   - Output 0: `new Utxo({ amount: net, blinding: random, pubkey: keys.notePubkey (as field element), mint })`, encrypted with `encryptUtxoTo(keys.encPubkey, ...)`. Output 1: own change, encrypted exactly as today.
   - Relay body `recipient` field = `this.feeRecipient` (convention, DESIGN-V2 #3); SOL non-relay path passes the fee recipient account as recipient too.
   - Return existing result fields plus `leafIndex` (the nextLeafIndex output 0 lands at) and `commitment` (hex string of output 0's commitment).
   - Unlock, syncNotes(treeKey, true), markNoteSpent, change-note wait/persist: identical to withdrawInternal.
3. Export all new symbols from `src/index.ts`.
4. Tests (mock fetch, existing patterns): ext 0 request body; output 0 pubkey equals fetched notePubkey; v3 prefix present in encrypted_output1; unregistered recipient throws; SPL path mirrors SOL. Fee and math hand-checked assertions (no loops over 100 iterations).
5. Commit: `feat(sdk): transferNoteSOL/SPL shielded transfers`.

## Task V2-5: Payroll shielded mode

Repo: `payroll/`.

1. `src/lib/types.ts`: `mode: "public" | "shielded"` (RunReceipt already has `mode: "public"`, widen it and the run request); entry type += `noteLeafIndex?: number; noteCommitment?: string`.
2. `src/lib/engine.ts` pay loop (~line 135): when `req.mode === "shielded"` call `client.transferNoteSOL(row.address, net)` / `transferNoteSPL(...)` instead of withdraw*; store `noteLeafIndex`/`noteCommitment` on the row; net-exact math unchanged (fee still comes from company input). WithdrawResult-compatible error/retry flow unchanged.
3. `src/hooks/usePayrollClient.ts`: add the parked stale-guard (`let cancelled = false` in the effect, checked in finally) — the one v1 deferred item, now in scope.
4. `src/components/PlanReviewCard.tsx`: replace the static `Shielded — v2` badge (~line 118) with a real Public/Private mode selector; when Private is selected, fetch `fetchRecipientKeys` for all rows on a "Check recipients" action (or on selection if cheap), render registered count and the unregistered address list, and disable Run while any row is unregistered. Pass `mode` through `onRun`.
5. `src/components/RunProgressCard.tsx` + `src/components/HistoryCard.tsx`: shielded rows show `note @ leaf N` (mono, from noteLeafIndex) beside the tx signature.
6. `src/App.tsx`: thread `mode` into `startRun`.
7. Tests: engine shielded-mode case (mock client records transferNote call with exact net, no withdraw call); types compile. `bun run test`, `bunx tsc --noEmit`, `bun run build` all green inside payroll/.
8. Commit: `feat(payroll): shielded payout mode`.

## Task V2-6: Frontend receive toggle

Repo: `frontend/`.

1. A "Private receiving" control in the existing settings/profile surface (find where wallet utilities live; smallest sensible placement): button "Enable private receiving" → `publishRecipientKeys(walletSigner)` via the SDK's existing signer plumbing (the frontend already constructs PrivacyCashClient; reuse its signer). On success show "Private receiving enabled" and the short note pubkey. On failure show the error inline.
2. SDK is consumed via workspace `file:` link, no version bump needed.
3. Build green (`bun run build` or the frontend's equivalent).
4. Commit: `feat(frontend): enable private receiving toggle`.

## Task V2-7: E2E on surfpool + docs

1. Committed script `payroll/scripts/e2e-v2.mjs` (node, uses the SDK directly with two throwaway keypairs as local signers): recipient publishes keys to local workers → treasurer deposits SOL → `transferNoteSOL` to recipient for a fixed net → recipient `syncNotes` finds exactly one new note of the expected amount → recipient withdraws it to a fresh address → balances asserted. Config via env: BACKEND_URL (default http://localhost:8787), RPC localhost:8899, PROGRAM_ID default 9PpZ9i...
2. Run it for real against: surfpool (running), local `wrangler dev` workers with D1 migration applied, program upgraded in V2-1. Include SPL variant if a devnet-forked mint with a tree exists; otherwise assert-skip with a printed note (do not fail the run).
3. Update `payroll/README.md`: v2 section (how receiving works, the one-time enable step, the E2E script invocation).
4. Commit: `feat(payroll): v2 e2e script and docs`.

## Final: whole-branch review over d50da95..HEAD (most capable model), one fix wave, then present options. Never push.
