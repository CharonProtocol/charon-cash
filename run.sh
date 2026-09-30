#!/usr/bin/env bash
# Local stack: postgres · surfpool · program · prover · SDK · backend shim · frontend
# Logs: /tmp/privacy-cash-{surfpool,backend,frontend}.log
#
#   ./run.sh          fast restart — shim + frontend only (no SBF rebuild/deploy)
#   ./run.sh --fresh  kill everything, new surfpool, rebuild + redeploy program
set -u
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh|-f) FRESH=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: ./run.sh [--fresh]

  ./run.sh          Fast restart: keep surfpool + on-chain program, restart
                    shim (:8080) and frontend (:5173). No cargo build-sbf.

  ./run.sh --fresh  Restart all: kill surfpool/shim/vite, rebuild prover +
                    program, redeploy, recreate ALT, restart shim + frontend.
EOF
      exit 0
      ;;
    *)
      echo "unknown flag: $arg  (try ./run.sh --help)" >&2
      exit 1
      ;;
  esac
done

L=/tmp/privacy-cash
rpc_up() { curl -s -m2 -X POST http://127.0.0.1:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; }
wait_http() { local url="$1" i; for i in $(seq 1 40); do curl -s -m2 -o /dev/null "$url" 2>/dev/null && return 0; sleep 1; done; return 1; }

if [ "$FRESH" = "1" ]; then
  echo "▶ 0/6  --fresh: stopping surfpool, shim, vite…"
  pkill -f backend-shim.mjs >/dev/null 2>&1 || true
  pkill -f "vite" >/dev/null 2>&1 || true
  pkill -f "surfpool start" >/dev/null 2>&1 || true
  pkill -x surfpool >/dev/null 2>&1 || true
  sleep 1
fi

echo "▶ 1/6  Postgres (docker) — optional, only the Rust backend needs it…"
if docker start privacycash-pg >/dev/null 2>&1 || docker run -d --name privacycash-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=privacy_cash -p 5432:5432 pgvector/pgvector:pg16 >/dev/null 2>&1; then
  echo "    db=privacy_cash on :5432"
else
  echo "    ⚠ docker not running — skipped (backend shim reads on-chain, Postgres optional)"
fi

echo "▶ 2/6  Surfpool (local Solana, :8899)…"
if rpc_up; then echo "    already running"; else
  nohup surfpool start > "$L-surfpool.log" 2>&1 &
  echo "    starting (log $L-surfpool.log)…"
  for i in $(seq 1 60); do rpc_up && break; sleep 1; done
  rpc_up && echo "    up" || { echo "    ✗ surfpool didn't come up — run 'surfpool start' in a terminal, then re-run ./run.sh"; exit 1; }
fi

echo "▶ 3/6  Program…"
mkdir -p target/deploy
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
EXISTING_ALT=""
if [ "$FRESH" != "1" ] && [ -f frontend/.env ]; then
  EXISTING_ALT=$(grep -E '^VITE_ALT_ADDRESS=' frontend/.env 2>/dev/null | cut -d= -f2- || true)
fi
perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$PROG"'");/' programs/privacy-cash/src/lib.rs

NEED_DEPLOY=0
if [ "$FRESH" = "1" ]; then
  NEED_DEPLOY=1
elif ! solana --url localhost program show "$PROG" >/dev/null 2>&1; then
  echo "    not on chain yet — deploying once"
  NEED_DEPLOY=1
fi
if [ "$NEED_DEPLOY" = "1" ]; then
  cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml 2>&1 | tail -1
  cp target/deploy/privacy_cash.so target/deploy/privacy-cash.so 2>/dev/null
  solana --url localhost --keypair "$HOME/.config/solana/id.json" program deploy target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json 2>&1 | grep -E "Program Id|Program Id:" || true
  echo "    $PROG deployed/upgraded"
else
  echo "    $PROG already deployed (skip rebuild — ./run.sh --fresh to upgrade)"
fi

cat > frontend/.env <<EOF
VITE_BACKEND_URL=http://127.0.0.1:8080
VITE_SOLANA_RPC_URL=http://127.0.0.1:8899
VITE_PROGRAM_ID=$PROG
EOF
if [ -n "${EXISTING_ALT:-}" ]; then
  echo "VITE_ALT_ADDRESS=$EXISTING_ALT" >> frontend/.env
fi
echo "    program=$PROG  (frontend/.env written)"

echo "▶ 3b/6 Address Lookup Table (needed for SPL txs)…"
if [ "$FRESH" != "1" ] && [ -n "${EXISTING_ALT:-}" ]; then
  echo "    reuse $EXISTING_ALT"
else
  ( cd frontend && PROGRAM_ID="$PROG" VITE_ALT_ADDRESS="${EXISTING_ALT:-}" bun scripts/create-alt.mjs 2>&1 | sed 's/^/    /' ) || echo "    ⚠ ALT create failed — SPL deposit will try to create one via wallet"
fi

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
wait_http http://127.0.0.1:8080/health && echo "    up" || { echo "    ✗ failed (log $L-backend.log)"; exit 1; }

echo "▶ 5/6  Frontend (:5173)…"
pkill -f "vite" >/dev/null 2>&1 || true; sleep 1
( cd frontend && nohup bun run dev > "$L-frontend.log" 2>&1 & )
wait_http http://127.0.0.1:5173 && echo "    up" || { echo "    ✗ failed (log $L-frontend.log)"; exit 1; }

if [ "$FRESH" = "1" ]; then
  MODE="fresh rebuild + redeploy"
else
  MODE="fast restart (no deploy)"
fi
cat <<EOF

✅  $MODE — open  http://127.0.0.1:5173
    frontend  http://127.0.0.1:5173
    backend   http://127.0.0.1:8080   (program $PROG)
    rpc       http://127.0.0.1:8899
    logs      /tmp/privacy-cash-{surfpool,backend,frontend}.log

    Private swap is relayer-signed (v1 packet). Phantom cannot sign v1 —
    connect a wallet to unlock notes; the shim submits Swap.

    fund your Phantom wallet on surfpool:
      solana airdrop 2 <phantom-address> --url localhost
    (Phantom network = http://127.0.0.1:8899)

    atomic swap e2e (empty trees — use ./run.sh --fresh first):
      cd frontend && PROGRAM_ID=$PROG BACKEND_URL=http://127.0.0.1:8080 bun scripts/e2e-swap.mjs

    ./run.sh          fast restart (shim + frontend)
    ./run.sh --fresh  kill surfpool, rebuild, redeploy
EOF
