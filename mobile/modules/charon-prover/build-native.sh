#!/usr/bin/env bash
# Builds the arkworks prover for Android and copies it, plus the circuit, into
# this module. Run from anywhere: modules/charon-prover/build-native.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
CRATE="$ROOT/crates/privacy-cash-prover"
NDK="${ANDROID_NDK_HOME:-$(ls -d "$HOME/Library/Android/sdk/ndk/"* | sort -V | tail -1)}"

ANDROID_NDK_HOME="$NDK" RUSTFLAGS= cargo ndk --manifest-path "$CRATE/Cargo.toml" \
  -t arm64-v8a -t x86_64 --platform 24 -o "$HERE/android/src/main/jniLibs" \
  build --release --lib --no-default-features --features android

mkdir -p "$HERE/android/src/main/assets/circuit"
cp "$ROOT/payroll/public/circuit/transaction2.zkey" "$ROOT/payroll/public/prover-wasm/transaction2.graph" \
  "$HERE/android/src/main/assets/circuit/"
echo "native prover + circuit copied into $HERE/android/src/main"
