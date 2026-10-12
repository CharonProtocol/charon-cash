#!/usr/bin/env bash
# run.sh - Local development flow automation for Privacy Cash
set -e # exit on error
set -u # exit on undefined variables

# Change to the root of the project
cd "$(dirname "$0")"
PROJECT_ROOT=$(pwd)

export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

# Logs directory
L=/tmp/privacy-cash
mkdir -p "$(dirname "$L")"

# Utility to check if Surfpool is up
rpc_up() {
  curl -s -m2 -X POST http://localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'
}

geyser_up() {
  lsof -nP -iTCP:10000 -sTCP:LISTEN >/dev/null 2>&1
}

echo "==========================================================="
echo "▶ 1/10 Starting Surfpool..."
pkill -f surfpool >/dev/null 2>&1 || true
pkill -f solana-test-validator >/dev/null 2>&1 || true
fuser -k 8899/tcp >/dev/null 2>&1 || true
fuser -k 8900/tcp >/dev/null 2>&1 || true
fuser -k 10000/tcp >/dev/null 2>&1 || true
sleep 1
# --no-tui is required under nohup; the dashboard cannot run in the background.
# config.json must use the macOS .dylib (absolute path), not the Linux .so.
(cd /tmp && nohup surfpool start -g "$HOME/yellowstone/config.json" --no-tui > "$L-surfpool.log" 2>&1 &)
echo "  Waiting for Surfpool to start..."
for i in $(seq 1 60); do
  rpc_up && geyser_up && break
  sleep 1
done
if rpc_up && geyser_up; then
  echo "  Surfpool started successfully (RPC :8899, Yellowstone :10000)."
else
  echo "  ✗ Surfpool didn't start. Check $L-surfpool.log"
  if rpc_up && ! geyser_up; then
    echo "  RPC is up but Yellowstone gRPC is not listening on :10000 (plugin failed to load)."
  fi
  tail -n 40 "$L-surfpool.log" || true
  exit 1
fi

echo "==========================================================="
echo "▶ 2/10 Starting Postgres database..."
# Always remove the old container to ensure a fresh database state
docker rm -f privacycash-pg >/dev/null 2>&1 || true

if docker run -d --name privacycash-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=privacy_cash -p 5433:5432 postgres:16-alpine >/dev/null 2>&1; then
  echo "  Postgres (fresh) started on :5433"
else
  echo "  ⚠ Docker not running or failed to start container, skipping database start."
fi

echo "==========================================================="
echo "▶ 3/10 Updating IDs and Keypairs..."
# Program ID must be known before the SBF build: singleton PDA addresses
# (`TREE_ACCOUNT_ADDRESS` and friends) are compile-time constants of
# `declare_id!` plus the canonical bumps for that id.
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
echo "  Program ID: $PROG"

# Fee Recipient Keypair
[ -f target/deploy/fee-recipient.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/fee-recipient.json
FEE_RECIPIENT_PUBKEY=$(solana-keygen pubkey target/deploy/fee-recipient.json)
echo "  Fee Recipient: $FEE_RECIPIENT_PUBKEY"

# Relayer Keypair
[ -f target/deploy/relayer.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/relayer.json
RELAYER_PUBKEY=$(solana-keygen pubkey target/deploy/relayer.json)
echo "  Relayer: $RELAYER_PUBKEY"
RELAYER_KP_PATH="$PROJECT_ROOT/target/deploy/relayer.json"
echo "  Funding Relayer..."
solana airdrop 10 "$RELAYER_PUBKEY" --url localhost >/dev/null 2>&1 || true

# Update lib.rs with Program ID
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

# Update backend/.env (perl -i, not sed -i: BSD sed on macOS treats the
# filename as the script and fails with "undefined label").
if [ -f backend/.env ]; then
  perl -ni -e 'print unless /^(PROGRAM_ID|RELAYER_KEYPAIR|DATABASE_URL|RELAYER_FEE_RECIPIENT|RELAYER_FEE_RECIPIENT_KEYPAIR|YELLOWSTONE_GRPC_URL|SOLANA_RPC_URL|INDEXER_RPC_FALLBACK)=/' backend/.env
fi
{
  echo "PROGRAM_ID=$PROG"
  echo "RELAYER_KEYPAIR=$RELAYER_KP_PATH"
  echo "DATABASE_URL=postgres://postgres:postgres@localhost:5433/privacy_cash"
  echo "RELAYER_FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY"
  echo "RELAYER_FEE_RECIPIENT_KEYPAIR=$PROJECT_ROOT/target/deploy/fee-recipient.json"
  echo "YELLOWSTONE_GRPC_URL=http://127.0.0.1:10000"
  echo "SOLANA_RPC_URL=http://127.0.0.1:8899"
  echo "INDEXER_RPC_FALLBACK=true"
} >> backend/.env

# Write to sdk/.env
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

  # Run alt-init and capture output
  echo "  Running alt-init.mjs..."
  ALT_OUTPUT=$(RELAYER_ADDRESS=$RELAYER_PUBKEY FEE_RECIPIENT=$FEE_RECIPIENT_PUBKEY PROGRAM_ID=$PROG bun run scripts/alt-init.mjs)
  echo "$ALT_OUTPUT" | sed 's/^/    /'

  ALT_ADDRESS=$(printf '%s\n' "$ALT_OUTPUT" | perl -ne 'print $1 if /ALT created: ([a-zA-Z0-9]+)/')
  if [ -n "$ALT_ADDRESS" ]; then
    echo "  Extracted ALT address: $ALT_ADDRESS"
    # Append new ALT to sdk/.env
    echo "ALT_ADDRESS=$ALT_ADDRESS" >> .env

    # Append ALT to backend/.env
    if [ -f ../backend/.env ]; then
      perl -ni -e 'print unless /^RELAYER_ALT_ADDRESS=/' ../backend/.env
    fi
    echo "RELAYER_ALT_ADDRESS=$ALT_ADDRESS" >> ../backend/.env

    # Write everything to frontend/.env for Vite
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
pkill -f "privacy_cash_backend" >/dev/null 2>&1 || true
pkill -f "privacy-cash-backend" >/dev/null 2>&1 || true
# Kill any existing cargo run just in case
pkill -f "cargo run" >/dev/null 2>&1 || true
sleep 1

(
  cd backend
  nohup cargo run > "$L-backend.log" 2>&1 &
)
echo "  Waiting for the backend and indexer..."
backend_up=0
for i in $(seq 1 180); do
  if curl -sf -m2 http://127.0.0.1:8080/health >/dev/null; then
    backend_up=1
    break
  fi
  sleep 1
done
if [ "$backend_up" -eq 1 ]; then
  echo "  Backend is up on :8080. The indexer catch-up keeps running with it. Logs: $L-backend.log"
else
  echo "  ✗ Backend didn't start. Check $L-backend.log"
  tail -n 40 "$L-backend.log" || true
  exit 1
fi

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
