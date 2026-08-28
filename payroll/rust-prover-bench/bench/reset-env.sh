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

# surfpool binary: same fallback pattern
SURFPOOL="$HOME/.local/bin/surfpool"
[[ -x "$SURFPOOL" ]] || SURFPOOL="$(command -v surfpool || true)"

# the program build must exist: keypair + .so with a matching declare_id
[[ -f target/deploy/privacy_cash-keypair.json && -f target/deploy/privacy_cash.so ]] || {
  echo "missing target/deploy/privacy_cash-keypair.json or target/deploy/privacy_cash.so"
  echo "one-time setup:"
  echo "  solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy_cash-keypair.json"
  echo "  PROG=\$(solana-keygen pubkey target/deploy/privacy_cash-keypair.json)"
  echo "  perl -0pi -e 's/declare_id!\\(\"[^\"]+\"\\);/declare_id!(\"\$PROG\");/' programs/privacy-cash/src/lib.rs"
  echo "  cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml"
  exit 1
}
PROG_ID=$(solana-keygen pubkey target/deploy/privacy_cash-keypair.json)

# relayer address: derived from the keypair the backend holds in .dev.vars
RELAYER_JSON=$(grep '^RELAYER_KEYPAIR_JSON=' workers/.dev.vars | cut -d= -f2-)
printf '%s' "$RELAYER_JSON" > /tmp/relayer-kp.json
RELAYER_ADDR=$(solana-keygen pubkey /tmp/relayer-kp.json)

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
nohup "$SURFPOOL" start > /dev/null 2>&1 &
sleep 12

# 2. redeploy the current program build (runbook may pick a stale artifact)
solana program deploy --url http://localhost:8899 --keypair ~/.config/solana/id.json \
  --program-id target/deploy/privacy_cash-keypair.json target/deploy/privacy_cash.so >/dev/null

# 3. D1 wipe + migrations
rm -rf workers/.wrangler/state
(cd workers && nohup $WRANGLER dev \
  --port 8787 \
  --var PROGRAM_ID:$PROG_ID \
  --var SUPPORTED_MINTS:11111111111111111111111111111112 > /tmp/wrangler.log 2>&1 &)
sleep 8
# migrations with the same pinned wrangler binary as dev; surface failures
(cd workers && $WRANGLER d1 migrations apply privacy-cash --local > /tmp/d1-migrate.log 2>&1) || { echo "D1 MIGRATIONS FAILED:"; tail -5 /tmp/d1-migrate.log; exit 1; }

# 4. fund relayer + initialize + sync
solana airdrop 500 --url http://localhost:8899 --keypair /tmp/deploy-payer.json \
  "$RELAYER_ADDR" >/dev/null
ADMIN_PW=$(grep ADMIN_PASSWORD workers/.dev.vars | cut -d= -f2)
# wait for wrangler to actually listen before talking to it
for i in {1..20}; do curl -s -m 2 localhost:8787/api/index >/dev/null 2>&1 && break; sleep 1; done
curl -sS -m 15 -X POST localhost:8787/api/relayer/initialize -H "x-admin-password: $ADMIN_PW" >/dev/null
curl -sS -m 15 -X POST localhost:8787/api/admin/sync -H "x-admin-password: $ADMIN_PW" >/dev/null

# 5. proxy with an empty replica at genesis
(cd payroll/rust-prover-bench/bench && nohup bun proxy.mjs > /tmp/proxy.log 2>&1 &)
sleep 2

echo "reset done:"
echo "  PROGRAM_ID=$PROG_ID"
echo "  relayer=$RELAYER_ADDR"
echo "  before run.mjs/run-batch.mjs: export PROGRAM_ID=$PROG_ID"
curl -s -m 5 localhost:8788/local/status
