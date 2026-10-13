#!/usr/bin/env bash
# Builds the wasm prover (single-thread + rayon multi-thread) and installs it
# into the payroll app:
#   ST -> payroll/src/lib/prover-wasm/*.js + payroll/public/prover-wasm/*_bg.wasm
#   MT -> payroll/public/prover-wasm-mt/ (raw static module, see prover-mt-worker.mjs)
# Needs: rustup target wasm32-unknown-unknown (stable + nightly w/ rust-src),
# wasm-bindgen CLI matching the crate's pinned wasm-bindgen (0.2.127).
# Usage: crates/privacy-cash-prover/build-wasm.sh [st|mt|both]
set -euo pipefail
cd "$(dirname "$0")"
CRATE=$PWD
APP=$CRATE/../../payroll
WHICH=${1:-both}
OUT=$CRATE/target/wasm-out
mkdir -p "$OUT"

if [[ $WHICH == st || $WHICH == both ]]; then
  cargo +stable build --release --target wasm32-unknown-unknown --no-default-features --features wasm \
    --target-dir target/wasm-st
  rm -rf "$OUT/st"
  wasm-bindgen --target web --out-dir "$OUT/st" --out-name privacy_cash_prover \
    target/wasm-st/wasm32-unknown-unknown/release/privacy_cash_prover.wasm
  cp "$OUT/st/privacy_cash_prover.js" "$OUT/st/privacy_cash_prover.d.ts" "$APP/src/lib/prover-wasm/"
  cp "$OUT/st/privacy_cash_prover_bg.wasm" "$APP/public/prover-wasm/"
  echo "ST installed"
fi

if [[ $WHICH == mt || $WHICH == both ]]; then
  RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals \
-C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=1073741824 \
-C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size \
-C link-arg=--export=__tls_align -C link-arg=--export=__tls_base" \
    cargo +nightly build --release --target wasm32-unknown-unknown --no-default-features \
      --features wasm-threads -Z build-std=panic_abort,std --target-dir target/wasm-mt
  rm -rf "$OUT/mt"
  wasm-bindgen --target web --out-dir "$OUT/mt" --out-name privacy_cash_prover \
    target/wasm-mt/wasm32-unknown-unknown/release/privacy_cash_prover.wasm
  for helper in "$OUT"/mt/snippets/*/src/workerHelpers.js; do
    # rayon's thread workers import the glue by package root; point them at the file
    perl -pi -e "s#import\('../../..'\)#import('../../../privacy_cash_prover.js')#" "$helper"
    grep -q "privacy_cash_prover.js" "$helper" || { echo "workerHelpers layout changed: $helper"; exit 1; }
  done
  rm -rf "$APP/public/prover-wasm-mt"
  mkdir -p "$APP/public/prover-wasm-mt"
  cp -R "$OUT/mt/privacy_cash_prover.js" "$OUT/mt/privacy_cash_prover.d.ts" \
    "$OUT/mt/privacy_cash_prover_bg.wasm" "$OUT/mt/snippets" "$APP/public/prover-wasm-mt/"
  echo "MT installed"
fi
