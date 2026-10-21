#!/usr/bin/env bash
# Compile circuits/transaction2.circom into a circom-witnesscalc witness graph
# (artifacts/circuits/transaction2.graph). The graph replaces transaction2.wasm
# for witness generation in crates/privacy-cash-prover (native and browser).
#
# Requirements: git, npm, cargo, and a `protoc` binary (PROTOC env var or PATH).
#
# Pinned versions — changing either changes the graph bytes and SHA256SUMS:
CWC_REPO="https://github.com/iden3/circom-witnesscalc"
CWC_REV="${CWC_REV:-d48eb7c9}"
CIRCOMLIB_VERSION="${CIRCOMLIB_VERSION:-2.0.5}"
# Must match the simplification level the zkey's r1cs was compiled with, or
# the witness length will not match the zkey's nVars.
CIRCOM_OPT="${CIRCOM_OPT:---O1}"

set -euo pipefail

PROGRAM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$PROGRAM_DIR/artifacts/circuits/transaction2.graph}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> circom-witnesscalc @ $CWC_REV"
if [[ -n "${BUILD_CIRCUIT_BIN:-}" ]]; then
  BIN="$BUILD_CIRCUIT_BIN"
else
  git clone -q "$CWC_REPO" "$WORK/cwc"
  git -C "$WORK/cwc" checkout -q "$CWC_REV"
  CARGO_TARGET_DIR="$WORK/target" cargo build --release -q \
    --manifest-path "$WORK/cwc/Cargo.toml" -p build-circuit
  BIN="$WORK/target/release/build-circuit"
fi

echo "==> circomlib@$CIRCOMLIB_VERSION"
# Circuits include "../scripts/node_modules/circomlib/...", so rebuild that layout.
mkdir -p "$WORK/src/circuits" "$WORK/src/scripts"
cp "$PROGRAM_DIR"/circuits/*.circom "$WORK/src/circuits/"
(cd "$WORK/src/scripts" && npm install --silent --no-save --no-package-lock "circomlib@$CIRCOMLIB_VERSION" >/dev/null)

echo "==> build-circuit transaction2.circom -> $OUT"
"$BIN" "$WORK/src/circuits/transaction2.circom" "$OUT" $CIRCOM_OPT

echo "==> sha256"
shasum -a 256 "$OUT"
echo "Update artifacts/circuits/SHA256SUMS and sdk/src/circuit-artifacts.ts if the hash changed."
