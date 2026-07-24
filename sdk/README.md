# Client SDK (implemented)

Fully client-side Privacy Cash SDK, rebased on **our** Pinocchio program and
**our** backend (read-only indexer data + merkle). No dependency on the official
remote relayer or mainnet program. Proofs, transaction building, signing and
RPC submission all happen in the browser. Withdraw-via-relayer is deferred.

## Modules

- `crypto.ts` — `Keypair`, `Utxo`, `EncryptionService`, `getExtDataHash`
- `prover.ts` — snarkjs groth16 prove + proof byte parsers
- `program.ts` — Pinocchio SOL + SPL instruction/tx builders (1-byte disc + bumps)
- `merkle.ts` — backend: info, tree, proof, **utxo range/check**, indexer wait helpers
- `notes.ts` — localStorage note store + sync offsets
- `client.ts` — `PrivacyCashClient`:
  - SOL: `depositSOL`, `withdrawSOL`, `getPrivateBalanceSOL`
  - SPL: `depositSPL`, `withdrawSPL`, `getPrivateBalanceSPL`
  - `syncNotes(treeKey)` on unlock (SOL tree) and before SPL withdraw
- `index.ts` — public barrel

## Flow

1. `init()` loads hasher wasm + `/api/relayer/info`
2. `unlock()` signs `SIGN_MESSAGE`, derives keys, runs `syncNotes("sol")`
3. **Deposit** — prove, wallet-sign, RPC submit, then **wait for indexer** (`waitForLeafIndex` / encrypted check)
4. **Withdraw** — spend local notes, fetch merkle paths from backend, wallet-sign, RPC submit
5. **Sync** — page `/api/utxos/range`, decrypt, nullifier-check, upsert notes

## Wire format note

Pinocchio 1-byte tags (`DISC_TRANSACT = 2`, `DISC_TRANSACT_SPL = 3`) + nullifier bumps.
SPL `ext_data_hash` uses **ATA** addresses (matches on-chain `transact_spl`).

