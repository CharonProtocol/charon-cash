#!/usr/bin/env bash
# run.sh - Local development flow automation for Privacy Cash
set -e # exit on error
set -u # exit on undefined variables

# Change to the root of the project
cd "$(dirname "$0")"

# Logs directory
L=/tmp/privacy-cash
mkdir -p "$(dirname "$L")"

# Utility to check if Surfpool is up
rpc_up() { 
  curl -s -m2 -X POST http://localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'
}

echo "==========================================================="
echo "▶ 1/10 Starting Surfpool..."
if rpc_up; then 
  echo "  Surfpool already running."
else
  nohup surfpool start -g ~/yellowstone/config.json > "$L-surfpool.log" 2>&1 &
  echo "  Waiting for Surfpool to start..."
  for i in $(seq 1 60); do 
    rpc_up && break
    sleep 1
  done
  rpc_up && echo "  Surfpool started successfully." || { echo "  ✗ Surfpool didn't start. Check $L-surfpool.log"; exit 1; }
fi

echo "==========================================================="
echo "▶ 2/10 Starting Postgres database..."
if docker start privacycash-pg >/dev/null 2>&1 || docker run -d --name privacycash-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=privacy_cash -p 5432:5432 postgres:16-alpine >/dev/null 2>&1; then
  echo "  Postgres started on :5432"
else
  echo "  ⚠ Docker not running, skipping database start."
fi

echo "==========================================================="
echo "▶ 3/10 Building program..."
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml

echo "==========================================================="
echo "▶ 4/10 Updating Program ID..."
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
echo "  New Program ID: $PROG"

# Update lib.rs
perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$PROG"'");/' programs/privacy-cash/src/lib.rs

# Update backend/.env
if [ -f backend/.env ]; then
  sed -i "s/^PROGRAM_ID=.*/PROGRAM_ID=$PROG/" backend/.env
else
  echo "PROGRAM_ID=$PROG" >> backend/.env
fi

# Update sdk/src/constants.ts
perl -0pi -e 's/export const PROGRAM_ID = new PublicKey\(\s*["\x27][^"\x27]+["\x27]\s*\);/export const PROGRAM_ID = new PublicKey(\n  "'"$PROG"'"\n);/' sdk/src/constants.ts

echo "==========================================================="
echo "▶ 5/10 Deploying program..."
cp target/deploy/privacy_cash.so target/deploy/privacy-cash.so 2>/dev/null || true
solana --url localhost --keypair "$HOME/.config/solana/id.json" program deploy target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json

echo "==========================================================="
echo "▶ 6/10 Running SDK setup scripts (initialize, init-spl, alt-init)..."
(
  cd sdk
  PROGRAM_ID=$PROG bun run scripts/initialize.mjs
  PROGRAM_ID=$PROG bun run scripts/init-spl.mjs
  
  # Run alt-init and capture output
  echo "  Running alt-init.mjs..."
  ALT_OUTPUT=$(PROGRAM_ID=$PROG bun run scripts/alt-init.mjs)
  echo "$ALT_OUTPUT" | sed 's/^/    /'
  
  ALT_ADDRESS=$(echo "$ALT_OUTPUT" | grep -oP 'ALT created: \K[a-zA-Z0-9]+' || true)
  if [ -n "$ALT_ADDRESS" ]; then
    echo "  Extracted ALT address: $ALT_ADDRESS"
    # Update sdk/src/constants.ts with new ALT
    perl -0pi -e 's/export const ALT_ADDRESS = new PublicKey\(\s*["\x27][^"\x27]+["\x27]\s*\);/export const ALT_ADDRESS = new PublicKey(\n  "'"$ALT_ADDRESS"'"\n);/' src/constants.ts
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
pkill -f "privacy_cash_backend" >/dev/null 2>&1 || true
pkill -f "privacy-cash-backend" >/dev/null 2>&1 || true
# Kill any existing cargo run just in case
pkill -f "cargo run" >/dev/null 2>&1 || true
sleep 1

(
  cd backend
  nohup cargo run > "$L-backend.log" 2>&1 &
)
echo "  Backend started in background. Logs: $L-backend.log"

echo "==========================================================="
echo "▶ 9/10 Linking SDK to frontend..."
(
  cd frontend
  bun add charonprotocol-sdk@workspace:*
)

echo "==========================================================="
echo "▶ 10/10 Starting Frontend..."
pkill -f "vite" >/dev/null 2>&1 || true
sleep 1

(
  cd frontend
  nohup bun run dev > "$L-frontend.log" 2>&1 &
)
echo "  Frontend started in background. Logs: $L-frontend.log"

echo "==========================================================="
echo "✅ Local development flow successfully started!"
echo "   Backend:  http://localhost:8080"
echo "   Frontend: http://localhost:5173"
echo "   RPC:      http://localhost:8899"
echo "   Logs:     $L-*.log"
