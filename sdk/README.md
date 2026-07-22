# Client SDK (implemented)

Fully client-side Privacy Cash SDK, rebased on **our** Pinocchio program and
**our** backend (read-only indexer data only). No dependency on the official
remote relayer or mainnet program. Proofs, transaction building, signing and
RPC submission all happen in the browser.

## Modules

- `crypto.ts` — `Keypair`, `Utxo` (Poseidon commitment/nullifier), `EncryptionService`
  (browser-native Web Crypto AES-256-GCM), `getExtDataHash` (byte-identical to the
  program's `calculate_complete_ext_data_hash` / backend `validate.rs`).
- `prover.ts` — snarkjs `groth16.fullProve` with the circuit wasm/zkey loaded as
  fetched ArrayBuffers, plus `parseProofToBytesArray` / `parseToBytesArray`.
- `program.ts` — builds the Pinocchio `transact` instruction (1-byte discriminator +
  `TransactArgs` layout + nullifier bumps) and the 11-account v0 transaction.
- `merkle.ts` — read-only backend fetchers (relayer info, tree state, Merkle proof,
  nullifier status), normalising field elements to decimal strings for the circuit.
- `notes.ts` — local (per-wallet) spendable-note store in `localStorage`.
- `client.ts` — `PrivacyCashClient`: `depositSOL`, `withdrawSOL`, `getPrivateBalanceSOL`.
- `index.ts` — public barrel.

## Flow

1. `init()` loads the hasher wasm + relayer info (program id, fee recipient, rates).
2. `unlock()` asks the wallet to `signMessage("Privacy Money account sign in")` and
   derives the deterministic note keypair.
3. **Deposit** — dummy inputs, one real output note (amount, random blinding) at the
   next leaf index, ext_amount > 0, fee 0. Wallet signs, tx submitted to RPC, note
   saved locally.
4. **Withdraw** — spends 1–2 local notes, fetches Merkle paths, ext_amount < 0, fee
   from the withdrawal rate. Wallet signs, tx submitted to RPC, spent notes marked,
   change note saved.

## Wire format note

The official `privacycash` SDK uses an 8-byte Anchor discriminator and relays a
pre-signed tx to its own relayer. This client instead emits the Pinocchio 1-byte
tag (`DISC_TRANSACT = 2`) and submits directly to the RPC — the relayer is not in
the client path.
