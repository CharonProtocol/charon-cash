# How to run / test

## Quick start (one command)
```bash
./run.sh       # surfpool + program + backend + apps; safe to re-run, heals what's missing
```
Then open http://localhost:5174 → Settings → **Local simnet** → Demo Wallet → Faucet → upload a CSV → Run.
Speed test on a new machine: `FAST=1 bench-kit/run-test.sh` (sends back `bench-kit/results/<host>-<time>.json`).

`run.sh` serves its own backend on :8080 (`frontend/scripts/backend-fast.mjs`). Don't also start the
Rust backend from step 3 below: two servers on :8080 split the app's requests (enrolled wallets show
"not enrolled", payouts look missing). `run.sh` stops a leftover one and refuses unknown programs on the port.

## Manual setup (Rust backend: Postgres + Yellowstone)

Run from the repo root. Install once: `surfpool`, `solana`, `cargo`, `bun`.
The upstream SDK must be cloned next to this repo (for the circuit files):
`git clone https://github.com/Privacy-Cash/privacy-cash-sdk` (one-time, not repeated below).

## 1. Start surfpool (local Solana)
```bash
surfpool start                       # RPC on http://localhost:8899
```

## 2. Build + deploy the program
```bash
# build
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml

# program keypair + make declare_id! match its address
solana-keygen new -o target/deploy/privacy-cash-program.json --no-bip39-passphrase --force
solana-keygen pubkey target/deploy/privacy-cash-program.json    # <- paste into declare_id!() in programs/privacy-cash/src/lib.rs
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml
cp target/deploy/privacy_cash.so target/deploy/privacy-cash.so

# deploy to surfpool
solana --url localhost --keypair ~/.config/solana/id.json program deploy \
  target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json
```

## 3. Start the backend (indexer + read-only API on :8080)
Needs Postgres + a Yellowstone gRPC endpoint.
```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/privacy_cash"
export YELLOWSTONE_GRPC_URL="https://your-yellowstone-endpoint"
export SOLANA_RPC_URL="http://localhost:8899"
export RELAYER_KEYPAIR="$HOME/.config/solana/id.json"
export PROGRAM_ID="<the deployed program id from step 2>"
cargo +stable run -p privacy-cash-backend
```

## 4. Frontend setup
```bash
cd frontend
bun install                           # postinstall copies hasher wasm + circuit
cp .env.example .env                  # set VITE_BACKEND_URL / VITE_SOLANA_RPC_URL / VITE_PROGRAM_ID
```

## 5. Test the SDK end-to-end on surfpool (no backend needed)
```bash
cd frontend
# set PROGRAM at the top of scripts/e2e-surfpool.mjs to your deployed id, then:
bun scripts/e2e-surfpool.mjs          # deploys + runs SOL & SPL deposit/withdraw
```

## 6. Run the frontend
```bash
cd frontend
bun run dev                           # http://localhost:5173  (connect Phantom to localhost:8899)
```

## 7. Unit tests + production build
```bash
cd frontend
bun run test                          # client-sdk proof/crypto tests
bun run build                         # tsc + vite
```

## Notes
- `declare_id!` must equal the deploy address (Pinocchio PDAs derive from it). Change one → rebuild + redeploy.
- Send txs with `skipPreflight: true` against surfpool (it lazy-loads accounts from mainnet during preflight).
- The e2e script keeps its own local Merkle mirror, so it works without the backend. The browser UI needs the backend up (step 3) for merkle/root/fees.
