# Privacy Cash Backend

Rust indexer and HTTP API for the Privacy Cash shielded pool: stream program
transactions via Yellowstone, persist commitments / nullifiers in Postgres, serve
Merkle proofs and UTXO sync, and expose admin / relayer setup endpoints.

Listens on `http://0.0.0.0:8080`.

## What Is Live Today

- Yellowstone gRPC subscription filtered to the Privacy Cash program
- Decode of `Transact` / `TransactSpl` instruction data into leaves + nullifiers
- Postgres schema with migrations (`sqlx migrate`)
- In-memory Poseidon Merkle mirror (height 26) rebuilt from stored commitments
- Read APIs: Merkle state / inclusion proof, UTXO range, encrypted-output check,
  nullifier status, relayer info
- Admin write APIs: initialize SOL / SPL trees, update global config, update
  deposit limits (signed by `RELAYER_KEYPAIR`)
- Withdraw-via-relayer endpoint (`POST /api/relayer`) with validation + submit

## Current Architecture

### Indexer

- Connects to Yellowstone; reconnects on stream failure
- Filters confirmed txs that touch `PROGRAM_ID`
- Decodes Pinocchio 1-byte discriminators for SOL / SPL transacts
- Assigns leaf indices per `tree_key` and writes UTXOs + nullifiers atomically
- Advances `indexer_cursor` (signature + slot)

### Database

Stores **leaves and nullifiers**, not a serialized on-chain tree blob:

| Table | Role |
| --- | --- |
| `indexer_cursor` | Last processed signature / slot |
| `trees` | `tree_key` → `next_index` |
| `utxos` | commitment + encrypted output per leaf |
| `nullifiers` | spent nullifier hashes |
| `indexed_txs` | idempotent signature ledger |

### Merkle mirror

- Rebuilds a Poseidon tree from `utxos` ordered by `leaf_index`
- Serves current root / `next_index` and Merkle paths for withdraw proofs
- Must match on-chain `light-hasher` / height-26 parameters

### Relayer / admin

- Loads a Solana keypair from `RELAYER_KEYPAIR` (JSON byte array)
- Signs and submits initialize / config / deposit-limit instructions
- `relay_withdraw` validates nullifiers, root, `ext_data_hash`, public amount,
  and fee, then builds and submits `Transact` / `TransactSpl`

### HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/indexer/status` | Cursor / indexer health |
| `GET` | `/api/relayer/info` | Program id, fees, supported mints |
| `GET` | `/api/merkle/{tree_key}` | Tree root + next index |
| `GET` | `/api/merkle/{tree_key}/proof/{leaf_index}` | Inclusion path |
| `GET` | `/api/nullifier/{hash}` | Spent? |
| `GET` | `/api/utxos/range?tree_key=&start=&end=` | Page encrypted outputs |
| `GET` | `/api/utxos/check/{hex}?tree_key=` | Lookup by encrypted hex |
| `POST` | `/api/relayer` / `/api/relayer/transact` | Relayed withdraw |
| `POST` | `/api/relayer/initialize` | Initialize SOL pool |
| `POST` | `/api/relayer/initialize-spl` | Initialize SPL tree for mint |
| `POST` | `/api/relayer/update-config` | Fee rates / margin |
| `POST` | `/api/relayer/update-deposit-limit` | SOL max deposit |
| `POST` | `/api/relayer/update-deposit-limit-spl` | SPL max deposit |

## Tree Keys

| Pool | `tree_key` |
| --- | --- |
| Native SOL | `sol` |
| SPL mint | base58 mint pubkey |

Clients pass `tree_key` into Merkle and UTXO endpoints. The SDK syncs notes by
paging `/api/utxos/range` and decrypting client-side.

## What Is Not Fully Productized Yet

- Demo UX still uses **wallet-signed** withdraws; relayer withdraw is API-ready
  but not the primary client path
- Local Surfpool demos often use the frontend **backend shim** instead of this
  crate (no Yellowstone / Postgres required)

## Layout

```text
backend/
├── Cargo.toml
├── .env.example
├── migrations/
│   └── 001_init.sql
└── src/
    ├── main.rs          # Axum server + indexer spawn
    ├── config.rs        # Env → Config
    ├── db.rs            # Postgres + migrations
    ├── state.rs         # AppState
    ├── indexer/         # Yellowstone stream + ix decode
    ├── relayer/         # Merkle mirror, validate, ix build, submit
    └── routes/          # HTTP handlers
```

## Prerequisites

- Rust stable (`cargo`)
- Postgres
- Yellowstone gRPC endpoint (and optional `x-token`)
- Solana RPC URL for the same cluster as the indexer
- Funded relayer keypair JSON (for admin / relay submit paths)

## Local Development

1. Copy env and fill values.

```bash
cp backend/.env.example backend/.env
```

2. Ensure Postgres is running and `DATABASE_URL` points at an empty or owned DB.

3. From the **repo root** (workspace member):

```bash
cargo run -p privacy-cash-backend
```

Migrations apply automatically on startup. Server: `http://localhost:8080`.

Set `PROGRAM_ID` to the deployed Pinocchio program. Indexer and Merkle mirror
are useless against the wrong program id.

For Surfpool-only UI demos without Yellowstone, use `./run.sh` (shim) — see
[`../RUN.md`](../RUN.md).

## Notes On State

- Encrypted outputs are stored for client sync; the backend cannot decrypt them
- Merkle roots served here must stay in sync with indexed leaves — lagging
  indexer → `UNKNOWN_ROOT` / failed withdraw proofs
- Relayer fee recipient is baked into withdraw `ext_data_hash` validation; the
  client must hash the same fee recipient the backend expects
- `SUPPORTED_MINTS` is informational for `/api/relayer/info`; on-chain mint
  allowlist is controlled by the program constants

## Validation

```bash
# From repo root
cargo check -p privacy-cash-backend
cargo build -p privacy-cash-backend
```

