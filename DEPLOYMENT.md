# Deploying the complete devnet app

Current handoff: [HANDOFF.md](HANDOFF.md). Local wallet flows have been verified
by the owner, the relayer was funded, and private Helius settings are in ignored
`backend/.env.devnet`. Hosted deployment and acceptance remain outstanding.

The privacy-cash Solana program is already deployed. Hosting the application does
not require redeploying or upgrading it. Jupiter Swap remains unavailable on
devnet; do not present it as part of the supported devnet flows.

## Local stack first

From the repository root:

```sh
docker compose -p charon-devnet -f compose.devnet.yml up -d db
node sdk/scripts/devnet-backend.mjs
# In another terminal:
bun run --cwd frontend dev:devnet
```

Open http://127.0.0.1:5173/#dashboard and select Devnet in the browser wallet.
The isolated database is on localhost:5434 with persistent storage. The backend
runner reads `backend/.env.devnet` if present, uses the recorded deployment
addresses, and creates a dedicated private relayer key under ignored
`target/deploy/devnet-relayer.json` if needed. It never deploys, requests an
airdrop, or funds the wallet automatically.

Put provider settings in `backend/.env.devnet`:

```dotenv
SOLANA_RPC_URL=<private devnet RPC URL>
# For local polling, no Yellowstone endpoint is needed:
INDEXER_RPC_FALLBACK=true
# Alternatively, use the live Yellowstone stream after startup RPC backfill:
# INDEXER_RPC_FALLBACK=false
# YELLOWSTONE_GRPC_URL=<devnet Yellowstone URL>
# YELLOWSTONE_X_TOKEN=<token if required>
```

Do not copy provider secrets into a `VITE_*` variable. The browser defaults to
public devnet RPC; if using a provider in the browser, use a separate key intended
for browser exposure and restricted to your frontend's origin.

The backend restores cached Merkle trees from Postgres, replays RPC history in
order across pages, and checks its roots and leaf counts against chain before
opening port 8080. Polling uses the persisted cursor and stops on a missing or
failed transaction fetch rather than skipping a leaf. Only one backend/indexer
instance should own a database and its Merkle cache.

```sh
bun run --cwd frontend check:devnet
```

Before publishing, test two wallets with SOL and TEST: registration, a public
send/deposit to a registered recipient, note discovery/decryption, shielded
transfer, withdrawal, page reload, and backend restart. Confirm the recipient's
balances and the on-chain transaction receipts. This also needs a funded relayer
and suitable test-token balances/ATAs. A health endpoint alone is not acceptance.

## Hosted topology

A straightforward first deployment uses one Linux host:

- Caddy (or equivalent) serves the built static frontend and terminates HTTPS.
- `/api/*`, `/health`, and `/indexer/*` proxy to the Rust backend on localhost:8080.
- One backend process runs the API, relayer, and indexer together.
- Postgres runs on a private connection with persistent storage and backups.
- The backend connects to the supplied devnet RPC and optionally Yellowstone.
- The existing Solana program, vaults, pools, and lookup table stay on devnet.

Using the same origin for the frontend and API matches the locally tested proxy
setup. Do not expose Postgres or the backend port publicly. The supplied
`compose.devnet.yml` is for the local database; production must use its own
password, storage/backup policy, and service supervision.

## Release steps (not executed)

1. Finish local acceptance and restart recovery tests. Record the commit and
   deployment addresses being released.
2. Build the backend with the checked-in backend lockfile on a compatible Linux
   build host: `cargo build --release --locked --manifest-path backend/Cargo.toml`.
   Build on a machine with enough space for native RocksDB compilation. The
   runtime needs a writable working directory for its derived Merkle cache.
3. Provision the private Postgres database and copy registrations/notes/history
   from the local devnet database if they are to be retained. Otherwise replay
   history from an RPC with sufficient historical coverage. Wallets must register
   in the new database; public on-chain history does not contain registrations.
4. Install the backend as a supervised service with a persistent working
   directory, `BACKEND_BIND_ADDR=127.0.0.1:8080`, the devnet program/mint/ALT values,
   private provider credentials, and a **separate funded relayer hot wallet**.
   Keep `RELAYER_FEE_RECIPIENT_KEYPAIR` unset unless automatic sweeping is intended.
   Keep `ADMIN_PASSWORD` unset unless operator mutations need to be enabled.
5. Build static assets with `bun run --cwd frontend build:devnet`. This includes
   SDK workers, both WASM prover builds, and the verified circuit artifacts.
   For a same-origin API, leave `VITE_BACKEND_URL` empty. Upload all of
   `frontend/dist`, not just its HTML and JavaScript files.
6. Configure HTTPS and the proxy. Send `Cross-Origin-Opener-Policy: same-origin`
   and `Cross-Origin-Embedder-Policy: require-corp` on frontend responses. Serve
   WASM with the correct content type. Check that the page is cross-origin
   isolated and can load all circuit and worker assets.
7. Run the same read-only account/root checks against the hosted backend, then
   repeat wallet acceptance on the hosted origin. Check service restart recovery,
   database backups, indexer lag, and relayer balance alerts.
8. Point the intended domain at the verified release only after approval. Keep a
   rollback to the previous static build/backend binary, preserving the database.

The current relayer fee-floor check is commented out. Zero-fee transfers spend
its devnet SOL float, so the operator must budget/refill that float. This setup
is not evidence of mainnet economics or mainnet readiness.

No external hosting, DNS change, program deployment, or program upgrade has been
performed by these setup steps.
