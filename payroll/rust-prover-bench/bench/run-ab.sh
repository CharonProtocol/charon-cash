#!/usr/bin/env bash
# One-shot 210-employee A/B benchmark: setup if needed, then
# baseline (1 employee/proof) vs batch (2 employees/proof) on a fresh
# local chain each side. Re-runnable; setup steps are idempotent.
# Total runtime ~10 min on a laptop (build-sbf + prover build dominate
# the first run; the benches themselves are ~85s + ~55s).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"

echo "===== tools check ====="
MISSING=0
for t in git cargo solana solana-keygen bun node perl; do
  command -v "$t" >/dev/null 2>&1 || { echo "MISSING: $t"; MISSING=1; }
done
command -v surfpool >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/surfpool" ]] || { echo "MISSING: surfpool"; MISSING=1; }
[[ $MISSING -eq 0 ]] || { echo "install the missing tools, then re-run"; exit 1; }

echo "===== [1/5] program keypair + declare_id ====="
[[ -f target/deploy/privacy_cash-keypair.json ]] || \
  solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy_cash-keypair.json
PROG=$(solana-keygen pubkey target/deploy/privacy_cash-keypair.json)
perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$PROG"'");/' programs/privacy-cash/src/lib.rs
grep -q "$PROG" programs/privacy-cash/src/lib.rs
echo "program id: $PROG"

echo "===== [2/5] workers/.dev.vars (local-only secrets) ====="
if [[ ! -f workers/.dev.vars ]]; then
  solana-keygen new --no-bip39-passphrase --silent -o /tmp/relayer.json
  printf 'RELAYER_KEYPAIR_JSON=%s\nSOLANA_RPC_URL=http://localhost:8899\nADMIN_PASSWORD=local-bench\n' \
    "$(cat /tmp/relayer.json)" > workers/.dev.vars
  echo "created (relayer keypair /tmp/relayer.json)"
else
  echo "exists, keeping it"
fi

echo "===== [3/5] program build (build-sbf) ====="
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml 2>&1 | tail -2

echo "===== [4/5] arkworks prover-server ====="
(cd payroll/rust-prover-bench && cargo build --release --bin prover-server 2>&1 | tail -1)

echo "===== [5/5] bench deps ====="
(cd payroll/rust-prover-bench/bench && bun install)

export PROGRAM_ID="$PROG"
POOLS=16 EMP=210 PAY=5000000

echo
echo "########## A) BASELINE — 1 employee per proof ##########"
zsh payroll/rust-prover-bench/bench/reset-env.sh
(cd payroll/rust-prover-bench/bench && bun run.mjs "$POOLS" "$EMP" "$PAY")

echo
echo "########## B) BATCH — 2 employees per proof ##########"
zsh payroll/rust-prover-bench/bench/reset-env.sh
(cd payroll/rust-prover-bench/bench && bun run-batch.mjs "$POOLS" "$EMP" "$PAY")

node -e '
const fs = require("fs");
const pick = d => {
  const f = fs.readdirSync(d).filter(x => x.endsWith(".json")).sort().map(x => d + "/" + x);
  return JSON.parse(fs.readFileSync(f.at(-1), "utf8")).summary;
};
const a = pick("/tmp/pfast"), b = pick("/tmp/pfast-batch");
const s = ms => (ms / 1000).toFixed(1) + "s";
console.log("\n===== A/B RESULT (" + a.employees + " employees, " + a.pools + " pools) =====");
console.log("baseline: pay wall " + s(a.payWallMs) + "  total " + s(a.totalWallMs) + "  lane failures " + a.laneFailures);
console.log("batch:    pay wall " + s(b.payWallMs) + "  total " + s(b.totalWallMs) + "  lane failures " + b.laneFailures);
console.log("speedup:  " + (a.payWallMs / b.payWallMs).toFixed(2) + "x on the pay wall");
console.log("(laptop reference: 82.4s vs 32.4s = 2.55x)");
'
