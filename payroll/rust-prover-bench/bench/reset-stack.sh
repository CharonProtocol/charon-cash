#!/bin/zsh
# Lean bench-stack reset for the payroll matrix: fresh surfpool (txv1),
# redeploy the built program, start bench-shim :8786 (auto tree-init) and the
# merkle replica proxy :8787. No wrangler/D1 — the shim replaces the worker.
#
#   SURFPOOL_BIN=~/.local/share/surfpool150/surfpool zsh reset-stack.sh
#
# Logs: /tmp/bench-{surfpool,shim,proxy}.log
set -e
cd "$(dirname "$0")"
REPO="$(cd ../../.. && pwd)"
TXV1_FEATURE="txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4"

SURFPOOL="${SURFPOOL_BIN:-$HOME/.local/share/surfpool150/surfpool}"
[[ -x "$SURFPOOL" ]] || SURFPOOL="$(command -v surfpool)"
[[ -n "$SURFPOOL" ]] || { echo "no surfpool binary (need >=1.5.0 for txv1)"; exit 1 }

PROG_ID=$(solana-keygen pubkey "$REPO/target/deploy/privacy_cash-keypair.json")
[[ -f "$REPO/target/deploy/privacy_cash.so" ]] || { echo "missing target/deploy/privacy_cash.so (cargo build-sbf first)"; exit 1 }

# 0. kill leftovers (prover children can RAM-starve the box)
pkill -9 -f '[p]rover-server' 2>/dev/null || true
pkill -9 -f '[s]urfpool' 2>/dev/null || true
pkill -9 -f '[b]ench-shim.mjs' 2>/dev/null || true
pkill -9 -f '[b]ench-backend.mjs' 2>/dev/null || true
pkill -9 -f '[p]roxy.mjs' 2>/dev/null || true
sleep 2

# 1. fresh chain (txv1 + offline: bare start forks mainnet and init fails)
nohup "$SURFPOOL" start --offline --feature "$TXV1_FEATURE" > /tmp/bench-surfpool.log 2>&1 &
up=0
for i in {1..60}; do
  curl -s -m 2 http://localhost:8899 -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"' && { up=1; break; }
  sleep 2
done
[[ $up -eq 1 ]] || { echo "surfpool not healthy on :8899"; tail -5 /tmp/bench-surfpool.log; exit 1; }

# 2. redeploy the current build
solana airdrop 200 --url http://localhost:8899 ~/.config/solana/id.json >/dev/null 2>&1 || true
solana program deploy --url http://localhost:8899 --keypair ~/.config/solana/id.json \
  --program-id "$REPO/target/deploy/privacy_cash-keypair.json" "$REPO/target/deploy/privacy_cash.so" >/dev/null

# 3. shim :8786 (auto-initializes the tree on boot) then proxy :8787 -> shim
nohup env RPC=http://127.0.0.1:8899 PORT=8786 PROGRAM_ID="$PROG_ID" \
  bun "$REPO/payroll/rust-prover-bench/bench/bench-shim.mjs" > /tmp/bench-shim.log 2>&1 &
for i in {1..30}; do grep -q "tree initialized\|already initialized" /tmp/bench-shim.log 2>/dev/null && break; sleep 1; done
grep -q "tree initialized\|already initialized" /tmp/bench-shim.log || { echo "shim init failed"; tail -5 /tmp/bench-shim.log; exit 1; }

nohup env BACKEND=http://127.0.0.1:8786 RPC=http://127.0.0.1:8899 PORT=8787 PROGRAM_ID="$PROG_ID" \
  bun "$REPO/payroll/rust-prover-bench/bench/proxy.mjs" > /tmp/bench-proxy.log 2>&1 &
for i in {1..10}; do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 localhost:8787/local/status)" == "200" ]] && break
  sleep 1
done
[[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 localhost:8787/local/status)" == "200" ]] || {
  echo "proxy not serving on :8787"; tail -5 /tmp/bench-proxy.log; exit 1; }

echo "stack reset done: PROGRAM_ID=$PROG_ID  shim=:8786 proxy=:8787"
