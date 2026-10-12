# How to run / test

Run from the repo root. Install once: `surfpool`, `solana`, `cargo`, `bun`.

Proofs are made on the user's device by the Rust prover compiled to wasm
(`crates/privacy-cash-prover`). There is no
prove endpoint. The circuit files it needs are in the repo
(`programs/privacy-cash/artifacts/circuits/transaction2.{zkey,graph}`), and the built
wasm is committed in two builds: `sdk/prover-wasm-mt/` (multi-threaded, used when the
page is cross-origin isolated) and `sdk/prover-wasm/` (single-threaded fallback). You
only need extra tools to rebuild those:

```bash
# rebuild sdk/prover-wasm{,-mt}/ after changing crates/privacy-cash-prover
rustup target add wasm32-unknown-unknown
rustup toolchain install nightly --profile minimal --component rust-src --target wasm32-unknown-unknown
cargo install wasm-pack
bun run --cwd sdk build:prover          # both; `node scripts/build-prover.mjs st` = stable-only

# rebuild transaction2.graph after changing the circuit (needs protoc on PATH or $PROTOC)
programs/privacy-cash/scripts/build-witness-graph.sh
```

The frontend's dev and build commands rebuild the SDK, verify the zkey and graph
against `artifacts/circuits/SHA256SUMS`, and copy them to `frontend/public/circuit/`.
The committed wasm builds are used as-is; use `bun run build:prover` above to rebuild them.

Threaded proving needs the page served with
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
`vite dev` / `vite preview` send them, and `frontend/public/_headers` covers
Netlify/Cloudflare Pages. Any other host must add them, or proofs silently run
single-threaded. Check in the browser console: `crossOriginIsolated` should be `true`.

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

## 3. Start the backend (indexer + API and relayer on :8080)
Needs Postgres + a Yellowstone gRPC endpoint.
```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/privacy_cash"
export YELLOWSTONE_GRPC_URL="https://your-yellowstone-endpoint"
export SOLANA_RPC_URL="http://localhost:8899"
export RELAYER_KEYPAIR="$HOME/.config/solana/id.json"
export PROGRAM_ID="<the deployed program id from step 2>"
# Enable only for local Surfpool if its Yellowstone stream omits transactions.
export INDEXER_RPC_FALLBACK=true
cargo +stable run --manifest-path backend/Cargo.toml
```

## 4. Frontend setup
```bash
cd frontend
bun install --frozen-lockfile
cp .env.example .env                  # set VITE_BACKEND_URL / VITE_SOLANA_RPC_URL / VITE_PROGRAM_ID
```

## 5. Test the program's deposit/withdraw flows locally (no backend needed)
```bash
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml --tools-version v1.52 -- --locked
cargo test --locked --workspace --all-targets -- --test-threads=1
```

## 6. Run the frontend
```bash
cd frontend
bun run dev                           # http://localhost:5173  (connect Phantom to localhost:8899)
```

## 7. Unit tests + production build
```bash
bun run --cwd sdk build
bun test --cwd sdk                    # encryption, storage, balance sync, WASM proofs
bun run --cwd frontend test
bun run --cwd frontend lint
bun run --cwd frontend build          # SDK + circuit assets + tsc + vite
cargo test --manifest-path backend/Cargo.toml

# program tests prove with the same crate the browser runs (no Wasmer)
cargo test --locked -p privacy-cash --release -- --test-threads=1

# prover fixtures: native compressed proofs and invalid-input rejection
cargo test --locked -p privacy-cash-prover
```

## 8. Timing
```bash
cargo run --locked -p privacy-cash-prover --release --example timing   # native parse / witness / prove
node sdk/bench/prove-timing.mjs                                            # wasm on V8 (Chrome's engine)
bun sdk/bench/prove-timing.mjs                                             # wasm on JavaScriptCore (Safari's engine)
node frontend/bench/run-browser-bench.mjs                                  # headless Chrome, SDK -> Web Worker; needs `bun run dev`
```

## Notes
- `declare_id!` must equal the deploy address. After changing it, rederive the singleton PDA addresses and bumps in `programs/privacy-cash/src/constants.rs` before rebuilding and redeploying; `run.sh` contains the local derivation steps.
- Send txs with `skipPreflight: true` against surfpool (it lazy-loads accounts from mainnet during preflight).
- LiteSVM/Mollusk tests use the built program and an off-chain Merkle mirror. The browser UI needs the backend up (step 3) for merkle/root/fees.
