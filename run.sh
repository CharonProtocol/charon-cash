#!/usr/bin/env bash
# Start the full privacy-cash local stack — one command, idempotent:
#   surfpool (--offline) · program build+deploy · tree init · backend shim
#   (with recipient registry) · frontend (:5173) · payroll app (:5174)
# Safe to re-run any time; each step heals only what is missing/broken.
# Logs: /tmp/privacy-cash-{surfpool,backend,frontend,payroll}.log
set -u
cd "$(dirname "$0")"
ROOT="$PWD"
export PATH="$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

L=/tmp/privacy-cash
PAYER_KEYPAIR="$HOME/.config/solana/id.json"
RECIPIENTS_FILE="$ROOT/payroll/.local-recipients.json"

rpc_up() { curl -s -m2 -X POST http://localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; }
wait_http() { local url="$1" i; for i in $(seq 1 60); do curl -s -m2 -o /dev/null "$url" 2>/dev/null && return 0; sleep 1; done; return 1; }
wait_rpc() { local i; for i in $(seq 1 60); do rpc_up && return 0; sleep 1; done; return 1; }

echo "▶ 1/7  Surfpool (local Solana, :8899, --offline)…"
if rpc_up; then echo "    already running"
else
  pkill -f '[s]urfpool' 2>/dev/null; sleep 1
  nohup surfpool start --offline > "$L-surfpool.log" 2>&1 &
  disown
  echo "    starting (log $L-surfpool.log)…"
  wait_rpc || { echo "    ✗ surfpool didn't come up — check $L-surfpool.log"; exit 1; }
fi
echo "    up"

echo "▶ 2/7  Program keypair + declare_id…"
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$PROG"'");/' programs/privacy-cash/src/lib.rs

echo "▶ 3/7  Program binary (build if missing)…"
if [ ! -f target/deploy/privacy_cash.so ]; then
  echo "    building (5-10 min on first run)…"
  cargo build-sbf --manifest-path "$ROOT/programs/privacy-cash/Cargo.toml" 2>&1 | tail -1
  cp -f target/deploy/privacy_cash.so target/deploy/privacy-cash.so 2>/dev/null || true
fi
[ -f target/deploy/privacy_cash.so ] || { echo "    ✗ build failed — see output above"; exit 1; }

echo "▶ 4/7  Deploy (skip if already on-chain)…"
if solana --url localhost program show "$PROG" >/dev/null 2>&1; then
  echo "    $PROG already deployed"
else
  solana --url localhost --keypair "$PAYER_KEYPAIR" program deploy target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json 2>&1 | grep "Program Id" || { echo "    ✗ deploy failed"; exit 1; }
fi

echo "▶ 5/7  Payer SOL + tree initialization…"
BAL=$(solana balance "$PAYER_KEYPAIR" --url localhost 2>/dev/null | grep -o '^[0-9]*' || echo 0)
if [ "${BAL:-0}" -lt 10 ]; then solana airdrop 100 "$PAYER_KEYPAIR" --url localhost >/dev/null 2>&1 && echo "    payer airdropped"; fi
cat > frontend/.env <<EOF
VITE_BACKEND_URL=http://localhost:8080
VITE_SOLANA_RPC_URL=http://localhost:8899
VITE_PROGRAM_ID=$PROG
EOF
# Preserve any existing ALT address across re-runs
if [ -f frontend/.env.local ]; then
  grep -E '^VITE_ALT_ADDRESS=' frontend/.env.local >> frontend/.env 2>/dev/null || true
fi
( cd frontend && PROGRAM_ID="$PROG" nohup bun scripts/backend-shim.mjs > "$L-backend.log" 2>&1 & )
wait_http http://localhost:8080/health || { echo "    ✗ shim failed (log $L-backend.log)"; exit 1; }
INIT=""
for i in $(seq 1 10); do
  INIT=$(curl -s -m 30 -X POST http://localhost:8080/api/relayer/initialize 2>/dev/null | head -c 200)
  echo "$INIT" | grep -q '"already-initialized"\|signature' && break
  sleep 2
done
TREE=$(curl -s -m 10 http://localhost:8080/api/merkle/sol 2>/dev/null)
echo "$TREE" | grep -q current_root && echo "    tree ready" || { echo "    ✗ tree init failed: $INIT"; exit 1; }

echo "▶ 6/7  Recipient registry…"
if [ -f "$RECIPIENTS_FILE" ]; then
  N=$(grep -c note_pubkey "$RECIPIENTS_FILE" 2>/dev/null || echo 0)
  echo "    $N enrolled wallets from payroll/.local-recipients.json"
else
  echo "    none yet — enroll wallets via the app (PUT /api/recipients) or seed $RECIPIENTS_FILE"
fi

echo "▶ 7/7  Apps: frontend (:5173) + payroll (:5174)…"
pkill -f "vite" >/dev/null 2>&1; sleep 1
( cd frontend && nohup bun run dev > "$L-frontend.log" 2>&1 & )
( cd payroll && nohup bun run dev -- --port 5174 --strictPort > "$L-payroll.log" 2>&1 & )
wait_http http://localhost:5173 && echo "    frontend up" || echo "    ⚠ frontend failed (log $L-frontend.log)"
wait_http http://localhost:5174 && echo "    payroll up" || echo "    ⚠ payroll failed (log $L-payroll.log)"

cat <<EOF

✅  all up — payroll: http://localhost:5174  (demo app: http://localhost:5173)
    Settings → "Local simnet" preset points the payroll app here.
    backend   http://localhost:8080   (program $PROG)
    rpc       http://localhost:8899   (surfpool --offline — resets on restart,
                                       run.sh redeploys/re-inits automatically)
    logs      /tmp/privacy-cash-{surfpool,backend,frontend,payroll}.log

    fund your Phantom on surfpool:
      solana airdrop 100 <phantom-address> --url localhost
    (Phantom network = http://localhost:8899)
EOF
