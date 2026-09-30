# How to run / test

Run from the repo root. Install once: `surfpool`, `solana`, `cargo`, `bun`.

Proofs are made on the user's device by the Rust prover compiled to wasm
(`crates/privacy-cash-prover`, see `docs/client-side-proving-build.md`). There is no
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
cd sdk && bun run build:prover          # both; `node scripts/build-prover.mjs st` = stable-only

# rebuild transaction2.graph after changing the circuit (needs protoc on PATH or $PROTOC)
programs/privacy-cash/scripts/build-witness-graph.sh
```

`./run.sh` checks the circuit files against `artifacts/circuits/SHA256SUMS`, builds both
wasm variants if either is missing (or with `--fresh`; it installs the nightly toolchain
via rustup for that), and copies the zkey and graph to `frontend/public/circuit/`.

Threaded proving (about 0.6–0.9 s instead of 2 s) needs the page served with
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
bun install                           # postinstall copies hasher wasm + transaction2.{zkey,graph} to public/circuit/
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

# program tests prove with the same crate the browser runs (no Wasmer)
cd programs/privacy-cash && cargo test --release

# prover crate: graph witness == Circom wasm witness, proofs verify
cd crates/privacy-cash-prover && cargo test --release
```

## 8. Timing
```bash
cd crates/privacy-cash-prover && cargo run --release --example timing   # native parse / witness / prove
node sdk/bench/prove-timing.mjs                                            # wasm on V8 (Chrome's engine)
bun sdk/bench/prove-timing.mjs                                             # wasm on JavaScriptCore (Safari's engine)
node frontend/bench/run-browser-bench.mjs                                  # headless Chrome, SDK -> Web Worker; needs `bun run dev`
cd frontend && bun bench/withdraw-timing.mjs                               # full relayed withdraw; needs surfpool + backend
```

## Notes
- `declare_id!` must equal the deploy address (Pinocchio PDAs derive from it). Change one → rebuild + redeploy.
- Send txs with `skipPreflight: true` against surfpool (it lazy-loads accounts from mainnet during preflight).
- The e2e script keeps its own local Merkle mirror, so it works without the backend. The browser UI needs the backend up (step 3) for merkle/root/fees.
