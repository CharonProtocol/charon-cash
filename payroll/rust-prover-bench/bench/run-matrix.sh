#!/bin/zsh
# Benchmark matrix for the payroll engine: rows x lanes x prover-pool-size,
# all on a fresh chain per config. Produces bench/results/*.log + summary.tsv.
#
#   zsh run-matrix.sh [native|wasm]     (default: both)
#
# native  = run-standard-v1.mjs  (CLI, native arkworks prover-server pool,
#           full employee keypairs + publishRecipientKeys + private notes)
# wasm    = run-e2e-wasm.mjs     (real PayrollEngine + wasm-arkworks prover
#           pool, public SOL payouts)
#
# Both engines get a pool-size sweep: native ARK_PROVERS (1/2 + machine
# default), wasm WasmProverPool workers (1/2/4). Machine default on this box
# is 4 (min(16, (RAM-3)/1.25, cores*0.75)), so the sweep is 1w and 2w around it.
set -e
cd "$(dirname "$0")"
MODE="${1:-both}"
PROG_ID=$(solana-keygen pubkey ../../../target/deploy/privacy_cash-keypair.json)
RES=results
mkdir -p "$RES"
ARK_THREADS=${ARK_THREADS:-2}

# rows:pools           — native, default prover pool (machine default = 4 here)
NATIVE_CFG=(210:1 210:2 210:4 210:6 210:8 210:12 210:16 100:1 100:2 100:4 100:8 100:16 50:1 50:2 50:4 50:8 5:1 5:2 5:4)
# rows:pools:ark_provers — native, prover-pool sweep
NATIVE_W_CFG=(210:4:1 210:4:2 210:1:1 210:1:2 100:4:1 100:4:2)

# rows:lanes:workers   — wasm, default 4 workers
WASM_CFG=(210:1:4 210:2:4 210:4:4 210:6:4 210:8:4 210:12:4 210:16:4 100:4:4 100:8:4 50:4:4 5:4:4 5:1:1)
# rows:lanes:workers   — wasm, prover-worker sweep
WASM_W_CFG=(210:4:1 210:4:2 210:1:1 210:1:2 100:4:1 100:4:2 50:4:1 50:4:2 5:4:1 5:4:2)

run_one() { # $1 label  $2... command
  local label="$1"; shift
  echo "== $label: $*"
  zsh reset-stack.sh || { echo "$label: STACK RESET FAILED" >> "$RES/summary.tsv"; return 1; }
  local t0=$(date +%s)
  if "$@" > "$RES/$label.log" 2>&1; then :; else echo "$label: RUN FAILED (see log)" >> "$RES/summary.tsv"; fi
  echo "$label wall=$(( $(date +%s) - t0 ))s" >> "$RES/summary.tsv"
}

if [[ "$MODE" == native || "$MODE" == both ]]; then
  for cfg in $NATIVE_CFG; do
    rows=${cfg%%:*}; pools=${cfg##*:}
    label="native-${rows}r-${pools}p"
    run_one "$label" env PROGRAM_ID="$PROG_ID" PROXY=http://127.0.0.1:8787 \
      ARK_THREADS=$ARK_THREADS OUT_DIR="$PWD/$RES/$label" \
      bun run-standard-v1.mjs "$pools" "$rows"
  done
  for cfg in $NATIVE_W_CFG; do
    rows=${cfg%%:*}; rest=${cfg#*:}; pools=${rest%%:*}; w=${rest##*:}
    label="native-${rows}r-${pools}p-arkp${w}"
    run_one "$label" env PROGRAM_ID="$PROG_ID" PROXY=http://127.0.0.1:8787 \
      ARK_THREADS=$ARK_THREADS ARK_PROVERS=$w OUT_DIR="$PWD/$RES/$label" \
      bun run-standard-v1.mjs "$pools" "$rows"
  done
fi

if [[ "$MODE" == wasm || "$MODE" == both ]]; then
  for cfg in $WASM_CFG; do
    rows=${cfg%%:*}; rest=${cfg#*:}; lanes=${rest%%:*}; workers=${rest##*:}
    label="wasm-${rows}r-${lanes}l-${workers}w"
    run_one "$label" bun --smol run-e2e-wasm.mjs "$rows" "$lanes" "$workers"
  done
  for cfg in $WASM_W_CFG; do
    rows=${cfg%%:*}; rest=${cfg#*:}; lanes=${rest%%:*}; workers=${rest##*:}
    label="wasm-${rows}r-${lanes}l-${workers}w"
    run_one "$label" bun --smol run-e2e-wasm.mjs "$rows" "$lanes" "$workers"
  done
fi

echo "matrix done — logs in $RES/, parse with bench/parse-matrix.mjs"
