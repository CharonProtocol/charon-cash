#!/bin/zsh
# Full local env reset for payroll benches: fresh chain, redeploy, D1 wipe,
# initialize, mirror sync, proxy restart. Run from anywhere.
set -e
# repo root from this script's location (bench/ -> rust-prover-bench -> payroll -> repo)
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"

# wrangler binary: prefer the local npx cache, fall back to PATH/npx resolution
WRANGLER="$HOME/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
[[ -x "$WRANGLER" ]] || WRANGLER="$(command -v wrangler || true)"
[[ -n "$WRANGLER" ]] || WRANGLER="npx -y wrangler"

# 0. kill leftovers (orphaned provers from killed benches can RAM-starve the box)
pkill -9 -f '[p]rover-server' 2>/dev/null || true
pkill -9 -f '[s]urfpool' 2>/dev/null || true
pkill -9 -f '[w]rangler-dist/cli.js' 2>/dev/null || true
pkill -9 -f '[w]orkerd' 2>/dev/null || true
pkill -f '[p]roxy.mjs' 2>/dev/null || true
sleep 2

# 0b. throwaway airdrop payer (recreated each run; /tmp cleanup eats it)
if [[ ! -f /tmp/deploy-payer.json ]]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile /tmp/deploy-payer.json >/dev/null
fi

# 1. fresh chain
nohup ~/.local/bin/surfpool start > /dev/null 2>&1 &
sleep 12

# 2. redeploy the current program build (runbook may pick a stale artifact)
solana program deploy --url http://localhost:8899 --keypair ~/.config/solana/id.json \
  --program-id target/deploy/privacy_cash-keypair.json target/deploy/privacy_cash.so >/dev/null

# 3. D1 wipe + migrations
rm -rf workers/.wrangler/state
(cd workers && nohup $WRANGLER dev \
  --port 8787 \
  --var PROGRAM_ID:721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr \
  --var SUPPORTED_MINTS:11111111111111111111111111111112 > /tmp/wrangler.log 2>&1 &)
sleep 8
# migrations with the same pinned wrangler binary as dev; surface failures
(cd workers && $WRANGLER d1 migrations apply privacy-cash --local > /tmp/d1-migrate.log 2>&1) || { echo "D1 MIGRATIONS FAILED:"; tail -5 /tmp/d1-migrate.log; exit 1; }

# 4. fund relayer + initialize + sync
solana airdrop 500 --url http://localhost:8899 --keypair /tmp/deploy-payer.json \
  BxHRD9W25Zcdgz4A8DyYaXakSqKxjMjjqsVFiPfaEFW3 >/dev/null
ADMIN_PW=$(grep ADMIN_PASSWORD workers/.dev.vars | cut -d= -f2)
# wait for wrangler to actually listen before talking to it
for i in {1..20}; do curl -s -m 2 localhost:8787/api/index >/dev/null 2>&1 && break; sleep 1; done
curl -sS -m 15 -X POST localhost:8787/api/relayer/initialize -H "x-admin-password: $ADMIN_PW" >/dev/null
curl -sS -m 15 -X POST localhost:8787/api/admin/sync -H "x-admin-password: $ADMIN_PW" >/dev/null

# 5. proxy with an empty replica at genesis
(cd payroll/rust-prover-bench/bench && nohup bun proxy.mjs > /tmp/proxy.log 2>&1 &)
sleep 2

echo "reset done:"
curl -s -m 5 localhost:8788/local/status
