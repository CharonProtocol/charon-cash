#!/usr/bin/env bash
# Local stack.
#
#   ./run.sh         Restart the backend and frontend. Keep Surfpool, Postgres,
#                    and the deployed program. Use this after a code change.
#   ./run.sh --fresh Wipe the local chain and database, then build, deploy, and
#                    initialize. Deposits from the previous chain will not spend.
set -e
set -u

cd "$(dirname "$0")"
PROJECT_ROOT=$(pwd)

export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

L=/tmp/privacy-cash
SURF_DB="$PROJECT_ROOT/target/surfpool/surfnet.sqlite"
FRESH=0

case "${1:-}" in
  "") FRESH=0 ;;
  --fresh) FRESH=1 ;;
  *)
    echo "usage: ./run.sh [--fresh]"
    exit 1
    ;;
esac

mkdir -p "$(dirname "$L")" "$(dirname "$SURF_DB")"

rpc_up() {
  curl -s -m2 -X POST http://localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'
}

geyser_up() {
  lsof -nP -iTCP:10000 -sTCP:LISTEN >/dev/null 2>&1
}

stop_surfpool() {
  pkill -f surfpool >/dev/null 2>&1 || true
  pkill -f solana-test-validator >/dev/null 2>&1 || true
  fuser -k 8899/tcp >/dev/null 2>&1 || true
  fuser -k 8900/tcp >/dev/null 2>&1 || true
  fuser -k 10000/tcp >/dev/null 2>&1 || true
  sleep 1
}

start_surfpool() {
  # --no-tui is required under nohup; the dashboard cannot run in the background.
  # config.json must use the macOS .dylib (absolute path), not the Linux .so.
  # --db keeps the ledger across process restarts. Without it, Surfpool is
  # in-memory and the next start is an empty chain.
  (cd /tmp && nohup surfpool start -g "$HOME/yellowstone/config.json" --no-tui --db "$SURF_DB" --surfnet-id charon > "$L-surfpool.log" 2>&1 &)
  echo "  Waiting for Surfpool to start..."
  for _ in $(seq 1 60); do
    rpc_up && geyser_up && break
    sleep 1
  done
  if rpc_up && geyser_up; then
    echo "  Surfpool started (RPC :8899, Yellowstone :10000)."
  else
    echo "  ✗ Surfpool didn't start. Check $L-surfpool.log"
    if rpc_up && ! geyser_up; then
      echo "  RPC is up but Yellowstone gRPC is not listening on :10000 (plugin failed to load)."
    fi
    tail -n 40 "$L-surfpool.log" || true
    exit 1
  fi
}

ensure_surfpool() {
  if [ "$FRESH" -eq 1 ]; then
    echo "  Resetting Surfpool ledger..."
    stop_surfpool
    rm -f "$SURF_DB" "$SURF_DB-wal" "$SURF_DB-shm"
    start_surfpool
    return
  fi
  if rpc_up && geyser_up; then
    echo "  Surfpool already running. Leaving the chain in place."
    return
  fi
  if [ ! -f "$SURF_DB" ]; then
    echo "  No saved Surfpool ledger. Run ./run.sh --fresh once to create the chain."
    exit 1
  fi
  echo "  Starting Surfpool from the saved ledger..."
  stop_surfpool
  start_surfpool
}

ensure_postgres() {
  if [ "$FRESH" -eq 1 ]; then
    docker rm -f privacycash-pg >/dev/null 2>&1 || true
    if docker run -d --name privacycash-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=privacy_cash -p 5433:5432 postgres:16-alpine >/dev/null 2>&1; then
      echo "  Postgres (fresh) started on :5433"
    else
      echo "  ⚠ Docker not running or failed to start container, skipping database start."
      return
    fi
  elif [ "$(docker inspect -f '{{.State.Running}}' privacycash-pg 2>/dev/null || true)" = "true" ]; then
    echo "  Postgres already running on :5433"
    return
  elif docker inspect privacycash-pg >/dev/null 2>&1; then
    docker start privacycash-pg >/dev/null
    echo "  Postgres started on :5433"
  else
    echo "  Postgres container is missing. Run ./run.sh --fresh once to create it."
    exit 1
  fi

  for _ in $(seq 1 30); do
    docker exec privacycash-pg pg_isready -U postgres >/dev/null 2>&1 && return
    sleep 1
  done
  echo "  ✗ Postgres did not accept connections. Check: docker logs privacycash-pg"
  exit 1
}

restart_backend() {
  pkill -f "privacy_cash_backend" >/dev/null 2>&1 || true
  pkill -f "privacy-cash-backend" >/dev/null 2>&1 || true
  pkill -f "cargo run" >/dev/null 2>&1 || true
  sleep 1
  (
    cd backend
    nohup cargo run > "$L-backend.log" 2>&1 &
  )
  echo "  Waiting for the backend and indexer..."
  for _ in $(seq 1 180); do
    if curl -sf -m2 http://127.0.0.1:8080/health >/dev/null; then
      echo "  Backend is up on :8080. Logs: $L-backend.log"
      return
    fi
    sleep 1
  done
  echo "  ✗ Backend didn't start. Check $L-backend.log"
  tail -n 40 "$L-backend.log" || true
  exit 1
}

restart_frontend() {
  pkill -f "vite" >/dev/null 2>&1 || true
  sleep 1
  (
    cd frontend
    nohup bun run dev > "$L-frontend.log" 2>&1 &
  )
  echo "  Frontend started. Logs: $L-frontend.log"
}

require_existing_setup() {
  local missing=0
  for f in \
    target/deploy/privacy-cash-program.json \
    target/deploy/relayer.json \
    target/deploy/fee-recipient.json \
    backend/.env \
    frontend/.env
  do
    if [ ! -f "$f" ]; then
      echo "  Missing $f"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    echo "  Run ./run.sh --fresh once to deploy and initialize."
    exit 1
  fi
}

if [ "$FRESH" -eq 0 ]; then
  echo "==========================================================="
  echo "Restarting without wiping the chain or database."
  echo "==========================================================="
  require_existing_setup
  ensure_surfpool
  ensure_postgres
  RELAYER_PUBKEY=$(solana-keygen pubkey target/deploy/relayer.json)
  solana airdrop 10 "$RELAYER_PUBKEY" --url localhost >/dev/null 2>&1 || true
  restart_backend
  restart_frontend
  echo "==========================================================="
  echo "Stack is up. Existing deposits are still on this chain."
  echo "   Backend:  http://localhost:8080"
  echo "   Frontend: http://localhost:5173"
  echo "   RPC:      http://localhost:8899"
  echo "   Wipe and redeploy with: ./run.sh --fresh"
  exit 0
fi

echo "==========================================================="
echo "Fresh chain. This deletes the local ledger and Postgres."
echo "==========================================================="

echo "==========================================================="
echo "▶ 1/10 Starting Surfpool..."
ensure_surfpool

echo "==========================================================="
echo "▶ 2/10 Starting Postgres database..."
ensure_postgres

echo "==========================================================="
echo "▶ 3/10 Updating IDs and Keypairs..."
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
echo "  Program ID: $PROG"

[ -f target/deploy/fee-recipient.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/fee-recipient.json
FEE_RECIPIENT_PUBKEY=$(solana-keygen pubkey target/deploy/fee-recipient.json)
echo "  Fee Recipient: $FEE_RECIPIENT_PUBKEY"

[ -f target/deploy/relayer.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/relayer.json
RELAYER_PUBKEY=$(solana-keygen pubkey target/deploy/relayer.json)
echo "  Relayer: $RELAYER_PUBKEY"
RELAYER_KP_PATH="$PROJECT_ROOT/target/deploy/relayer.json"
echo "  Funding Relayer..."
solana airdrop 10 "$RELAYER_PUBKEY" --url localhost >/dev/null 2>&1 || true

perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$PROG"'");/' programs/privacy-cash/src/lib.rs

pda_bump() {
  local seed="$1"
  (cd "$PROJECT_ROOT/sdk" && SEED="$seed" PROGRAM_ID="$PROG" node --input-type=module -e '
import { PublicKey } from "@solana/web3.js";
const [, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from(process.env.SEED)],
  new PublicKey(process.env.PROGRAM_ID),
);
process.stdout.write(String(bump));
')
}

TREE_ACCOUNT_BUMP=$(pda_bump merkle_tree)
TREE_TOKEN_ACCOUNT_BUMP=$(pda_bump tree_token)
GLOBAL_CONFIG_BUMP=$(pda_bump global_config)
echo "  Canonical PDA bumps: merkle_tree=$TREE_ACCOUNT_BUMP tree_token=$TREE_TOKEN_ACCOUNT_BUMP global_config=$GLOBAL_CONFIG_BUMP"
perl -pi -e 's/pub const TREE_ACCOUNT_BUMP: u8 = \d+;/pub const TREE_ACCOUNT_BUMP: u8 = '"$TREE_ACCOUNT_BUMP"';/' programs/privacy-cash/src/constants.rs
perl -pi -e 's/pub const TREE_TOKEN_ACCOUNT_BUMP: u8 = \d+;/pub const TREE_TOKEN_ACCOUNT_BUMP: u8 = '"$TREE_TOKEN_ACCOUNT_BUMP"';/' programs/privacy-cash/src/constants.rs
perl -pi -e 's/pub const GLOBAL_CONFIG_BUMP: u8 = \d+;/pub const GLOBAL_CONFIG_BUMP: u8 = '"$GLOBAL_CONFIG_BUMP"';/' programs/privacy-cash/src/constants.rs

if [ -f backend/.env ]; then
  perl -ni -e 'print unless /^(PROGRAM_ID|RELAYER_KEYPAIR|DATABASE_URL|RELAYER_FEE_RECIPIENT|RELAYER_FEE_RECIPIENT_KEYPAIR|YELLOWSTONE_GRPC_URL|SOLANA_RPC_URL)=/' backend/.env
fi
{
  echo "PROGRAM_ID=$PROG"
  echo "RELAYER_KEYPAIR=$RELAYER_KP_PATH"
  echo "DATABASE_URL=postgres://postgres:postgres@localhost:5433/privacy_cash"
  echo "RELAYER_FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY"
  echo "RELAYER_FEE_RECIPIENT_KEYPAIR=$PROJECT_ROOT/target/deploy/fee-recipient.json"
  echo "YELLOWSTONE_GRPC_URL=http://127.0.0.1:10000"
  echo "SOLANA_RPC_URL=http://127.0.0.1:8899"
} >> backend/.env

cat > sdk/.env <<EOF
PROGRAM_ID=$PROG
FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY
RELAYER_ADDRESS=$RELAYER_PUBKEY
EOF

echo "==========================================================="
echo "▶ 4/10 Building program..."
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml

echo "==========================================================="
echo "▶ 5/10 Deploying program..."
cp target/deploy/privacy_cash.so target/deploy/privacy-cash.so 2>/dev/null || true
solana --url localhost --keypair "$HOME/.config/solana/id.json" program deploy target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json --use-rpc

echo "==========================================================="
echo "▶ 6/10 Running SDK setup scripts (initialize, init-spl, alt-init)..."
(
  cd sdk
  FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY PROGRAM_ID=$PROG bun run scripts/initialize.mjs
  PROGRAM_ID=$PROG bun run scripts/init-spl.mjs

  echo "  Running alt-init.mjs..."
  ALT_OUTPUT=$(RELAYER_ADDRESS=$RELAYER_PUBKEY FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY PROGRAM_ID=$PROG bun run scripts/alt-init.mjs)
  echo "$ALT_OUTPUT" | sed 's/^/    /'

  ALT_ADDRESS=$(printf '%s\n' "$ALT_OUTPUT" | perl -ne 'print $1 if /ALT created: ([a-zA-Z0-9]+)/')
  if [ -n "$ALT_ADDRESS" ]; then
    echo "  Extracted ALT address: $ALT_ADDRESS"
    echo "ALT_ADDRESS=$ALT_ADDRESS" >> .env

    if [ -f ../backend/.env ]; then
      perl -ni -e 'print unless /^RELAYER_ALT_ADDRESS=/' ../backend/.env
    fi
    echo "RELAYER_ALT_ADDRESS=$ALT_ADDRESS" >> ../backend/.env

    cat > ../frontend/.env <<EOF
VITE_BACKEND_URL=http://localhost:8080
VITE_SOLANA_RPC_URL=http://localhost:8899
VITE_PROGRAM_ID=$PROG
VITE_FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY
VITE_ALT_ADDRESS=$ALT_ADDRESS
EOF
    echo "  Wrote frontend/.env"
  else
    echo "  ⚠ Could not parse ALT address."
  fi
)

echo "==========================================================="
echo "▶ 7/10 Building SDK..."
(
  cd sdk
  bun run build
)

echo "==========================================================="
echo "▶ 8/10 Starting Backend (Relayer)..."
restart_backend

echo "==========================================================="
echo "▶ 9/10 Linking SDK to frontend..."
(
  cd frontend
  bun add charonprotocol-sdk@workspace:*
)

echo "==========================================================="
echo "▶ 10/10 Starting Frontend..."
restart_frontend

echo "==========================================================="
echo "Fresh local chain is up."
echo "   Backend:  http://localhost:8080"
echo "   Frontend: http://localhost:5173"
echo "   RPC:      http://localhost:8899"
echo "   Logs:     $L-*.log"
echo "   Next time, ./run.sh keeps this chain. ./run.sh --fresh wipes it."
