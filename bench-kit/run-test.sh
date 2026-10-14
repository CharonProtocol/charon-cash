#!/usr/bin/env bash
# Charon Cash speed test — one command, macOS or Linux, from anywhere:
#
#   bench-kit/run-test.sh          # default browser prover
#   FAST=1 bench-kit/run-test.sh   # + the wide-arithmetic build (Chrome V8 flag)
#
# Sets up a local Solana chain (surfpool), the program, the backend and the
# payroll app (run.sh), makes 100 local test employees (keys stay on this
# machine), pays them from a headless browser exactly like the app does,
# checks every note on-chain, and writes bench-kit/results/<host>-<time>.json
# to send back. Safe to re-run. Missing tools are installed only after asking.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
KIT="$ROOT/bench-kit"
LOCAL="$KIT/.local"
mkdir -p "$LOCAL" "$KIT/results"
export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
ROWS="${ROWS:-100}"
BACKEND=http://localhost:8080

ask() { local a; read -r -p "$1 [y/N] " a </dev/tty || true; [[ "$a" == y || "$a" == Y ]]; }
need() {
  # need <command> <what> <install command>
  command -v "$1" >/dev/null 2>&1 && return 0
  echo "✗ $2 is not installed."
  echo "  install command: $3"
  ask "  install it now?" || { echo "  stopping: install $2 and re-run."; exit 1; }
  bash -c "$3"
  export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
  command -v "$1" >/dev/null 2>&1 || { echo "  $2 still not on PATH — open a new terminal and re-run."; exit 1; }
}

echo "▶ 1/6  Tools"
need bun "Bun" "curl -fsSL https://bun.sh/install | bash"
need cargo "Rust" "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
need solana "Solana CLI" 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
need surfpool "Surfpool (local Solana)" "curl -sL https://run.surfpool.run/ | bash"
[ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase --silent -o "$HOME/.config/solana/id.json"
echo "    ok: bun $(bun --version), $(solana --version | head -c 40), $(surfpool --version)"

echo "▶ 2/6  Dependencies + SDK build"
bun install --silent >/dev/null
(cd payroll && bun install --silent >/dev/null)
(cd sdk && bun run build >/dev/null)
CHROME_DIR="$HOME/.cache/charon-browsers"
if ! ls "$CHROME_DIR"/chrome-headless-shell/*/*/chrome-headless-shell >/dev/null 2>&1; then
  echo "    downloading headless Chrome (one time)…"
  bunx @puppeteer/browsers install chrome-headless-shell@stable --path "$CHROME_DIR" >/dev/null
fi

echo "▶ 3/6  Local chain + program + backend + app (first run builds the program: 5-10 min)"
./run.sh > "$LOCAL/stack.log" 2>&1 || { echo "    ✗ stack failed — see $LOCAL/stack.log"; tail -20 "$LOCAL/stack.log"; exit 1; }
echo "    up (log $LOCAL/stack.log)"

echo "▶ 4/6  $ROWS test employees"
bun "$KIT/make-employees.ts" "$LOCAL" "$ROWS" "$BACKEND"
CSV="$LOCAL/employees-$ROWS.csv"

leaves() { curl -s "$BACKEND/api/merkle/sol" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).next_leaf_index)'; }
run_one() {
  # run_one <label> [extra run-bench args…] -> prints the result file path
  local label="$1"; shift
  local from to out file
  from=$(leaves)
  out=$(bun payroll/bench/run-bench.mjs --rows "$ROWS" --csv "$CSV" --label "$label" "$@" 2>&1) || { echo "$out" >&2; return 1; }
  to=$(leaves)
  file=$(echo "$out" | sed -n 's/^  saved //p' | tail -1)
  echo "$out" | grep -E "rows, |wall|proofs" >&2
  echo "    verifying every note on-chain…" >&2
  bun "$KIT/verify-notes.ts" "$LOCAL/employees-keys.json" "$CSV" "$from" "$to" "$BACKEND" > "$LOCAL/verify-$label.json" || true
  echo "    $(cat "$LOCAL/verify-$label.json")" >&2
  echo "$ROOT/$file|$LOCAL/verify-$label.json"
}

echo "▶ 5/6  Payroll run (headless browser, default prover)"
RUNS=("$(run_one kit-default)")
if [ "${FAST:-0}" = "1" ]; then
  echo "▶ 5b    Payroll run (wide-arithmetic build)"
  RUNS+=("$(run_one kit-fast --jsflags --experimental-wasm-wide-arithmetic)")
fi

echo "▶ 6/6  Result file"
HOST=$(hostname -s 2>/dev/null || hostname)
OUT="$KIT/results/$HOST-$(date +%Y%m%d-%H%M%S).json"
if [ "$(uname)" = Darwin ]; then
  MACHINE=$(printf '{"os":"macOS %s","model":"%s","cpu":"%s","cores":%s,"pCores":"%s","eCores":"%s","memGB":%s}' \
    "$(sw_vers -productVersion)" "$(sysctl -n hw.model)" "$(sysctl -n machdep.cpu.brand_string)" "$(sysctl -n hw.ncpu)" \
    "$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || echo ?)" "$(sysctl -n hw.perflevel1.physicalcpu 2>/dev/null || echo ?)" \
    "$(( $(sysctl -n hw.memsize) / 1073741824 ))")
else
  MACHINE=$(printf '{"os":"%s","cpu":"%s","cores":%s,"memGB":%s}' \
    "$(uname -sr)" "$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)" "$(nproc)" \
    "$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1048576 ))")
fi
bun "$KIT/summarize.ts" "$OUT" "$MACHINE" "${RUNS[@]}"
echo
cat <<EOF
✅ done — send this file back: $OUT

Everything is still running locally, so you can try it yourself in the browser:
  1. Open http://localhost:5174 in Chrome (or any Chromium browser).
  2. Settings → "Local simnet" → Demo Wallet → Faucet +10.
  3. Upload $CSV → keep the recommended lanes → Run.
  Faster proofs (optional): quit the browser fully, then start it with
    --js-flags=--experimental-wasm-wide-arithmetic
  e.g. macOS Chrome:
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --js-flags=--experimental-wasm-wide-arithmetic
EOF
