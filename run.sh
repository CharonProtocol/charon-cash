#!/usr/bin/env bash
# Start the full privacy-cash local stack:
#   postgres (docker) · surfpool · program deploy · backend shim · frontend
# Idempotent — safe to re-run. Logs: /tmp/privacy-cash-{surfpool,backend,frontend}.log
set -u
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

L=/tmp/privacy-cash
rpc_up() { curl -s -m2 -X POST http://localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; }
wait_http() { local url="$1" i; for i in $(seq 1 40); do curl -s -m2 -o /dev/null "$url" 2>/dev/null && return 0; sleep 1; done; return 1; }

echo "▶ 1/5  Postgres (docker) — optional, only the Rust backend needs it…"
if docker start privacycash-pg >/dev/null 2>&1 || docker run -d --name privacycash-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=privacy_cash -p 5432:5432 pgvector/pgvector:pg16 >/dev/null 2>&1; then
  echo "    db=privacy_cash on :5432"
else
  echo "    ⚠ docker not running — skipped (backend shim reads on-chain, Postgres optional)"
fi

echo "▶ 2/5  Surfpool (local Solana, :8899)…"
if rpc_up; then echo "    already running"; else
  nohup surfpool start > "$L-surfpool.log" 2>&1 &
  echo "    starting (log $L-surfpool.log)…"
  for i in $(seq 1 60); do rpc_up && break; sleep 1; done
  rpc_up && echo "    up" || { echo "    ✗ surfpool didn't come up — run 'surfpool start' in a terminal, then re-run ./run.sh"; exit 1; }
fi

echo "▶ 3/5  Program (deploy if missing)…"
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
EXISTING_ALT=""
if [ -f frontend/.env ]; then
  EXISTING_ALT=$(grep -E '^VITE_ALT_ADDRESS=' frontend/.env 2>/dev/null | cut -d= -f2- || true)
fi
perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$PROG"'");/' programs/privacy-cash/src/lib.rs
if solana --url localhost program show "$PROG" >/dev/null 2>&1; then
  echo "    $PROG already deployed"
else
  cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml 2>&1 | tail -1
  cp target/deploy/privacy_cash.so target/deploy/privacy-cash.so 2>/dev/null
  solana --url localhost --keypair "$HOME/.config/solana/id.json" program deploy target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json 2>&1 | grep "Program Id"
fi
cat > frontend/.env <<EOF
VITE_BACKEND_URL=http://localhost:8080
VITE_SOLANA_RPC_URL=http://localhost:8899
VITE_PROGRAM_ID=$PROG
EOF
# Preserve any existing ALT address across re-runs
if [ -n "${EXISTING_ALT:-}" ]; then
  echo "VITE_ALT_ADDRESS=$EXISTING_ALT" >> frontend/.env
fi
echo "    program=$PROG  (frontend/.env written)"

echo "▶ 3b/5 Address Lookup Table (needed for SPL txs)…"
( cd frontend && PROGRAM_ID="$PROG" VITE_ALT_ADDRESS="${EXISTING_ALT:-}" bun scripts/create-alt.mjs 2>&1 | sed 's/^/    /' ) || echo "    ⚠ ALT create failed — SPL deposit will try to create one via wallet"

echo "▶ 3c/6 Browser Groth16 prover (wasm + circuit artifacts)…"
CIRCUITS=programs/privacy-cash/artifacts/circuits
( cd programs/privacy-cash && shasum -a 256 -c artifacts/circuits/SHA256SUMS --quiet ) \
  || { echo "    ✗ circuit artifacts do not match SHA256SUMS"; exit 1; }
PROVER_WASM=sdk/prover-wasm/privacy_cash_prover_bg.wasm
PROVER_WASM_MT=sdk/prover-wasm-mt/privacy_cash_prover_bg.wasm
if [ "$FRESH" = "1" ] || [ ! -f "$PROVER_WASM" ] || [ ! -f "$PROVER_WASM_MT" ]; then
  command -v wasm-pack >/dev/null || { echo "    ✗ wasm-pack missing: cargo install wasm-pack --locked"; exit 1; }
  # Threaded variant needs nightly + rust-src (build-std with atomics).
  rustup toolchain install nightly --profile minimal --component rust-src \
    --target wasm32-unknown-unknown >/dev/null 2>&1 \
    || { echo "    ✗ could not install nightly toolchain (needed for threaded prover)"; exit 1; }
  ( set -o pipefail; cd sdk && bun run build:prover 2>&1 | grep -E "Done|rror" | sed 's/^/    /' ) || { echo "    ✗ prover wasm build failed"; exit 1; }
  [ -f "$PROVER_WASM_MT" ] || { echo "    ✗ threaded prover wasm missing after build"; exit 1; }
fi
mkdir -p frontend/public/circuit
rm -f frontend/public/circuit/transaction2.wasm
cp "$CIRCUITS/transaction2.zkey" "$CIRCUITS/transaction2.graph" frontend/public/circuit/
echo "    $PROVER_WASM, $PROVER_WASM_MT, frontend/public/circuit/{transaction2.zkey,transaction2.graph}"

echo "▶ 3d/6 SDK (frontend imports dist/)…"
( cd sdk && bun run build 2>&1 | tail -5 | sed 's/^/    /' ) || { echo "    ✗ sdk build failed"; exit 1; }

echo "▶ 4/6  Backend shim (:8080, reads on-chain via RPC, signs v1 swaps)…"
pkill -f backend-shim.mjs >/dev/null 2>&1 || true; sleep 1
( cd frontend && PROGRAM_ID="$PROG" nohup bun scripts/backend-shim.mjs > "$L-backend.log" 2>&1 & )
wait_http http://localhost:8080/health && echo "    up" || { echo "    ✗ failed (log $L-backend.log)"; exit 1; }

echo "▶ 5/5  Frontend (:5173)…"
pkill -f "vite" >/dev/null 2>&1; sleep 1
( cd frontend && nohup bun run dev > "$L-frontend.log" 2>&1 & )
wait_http http://localhost:5173 && echo "    up" || { echo "    ✗ failed (log $L-frontend.log)"; exit 1; }

cat <<EOF

✅  all up — open  http://localhost:5173
    frontend  http://localhost:5173
    backend   http://localhost:8080   (program $PROG)
    rpc       http://localhost:8899
    logs      /tmp/privacy-cash-{surfpool,backend,frontend}.log

    fund your Phantom wallet on surfpool:
      solana airdrop 2 <phantom-address> --url localhost
    (Phantom network = http://localhost:8899)
EOF
