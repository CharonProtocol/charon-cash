#!/usr/bin/env bash
set -euo pipefail

# Proves the committed circuit sources, compiled circuit, proving key and the
# key embedded in the program all describe the same Groth16 circuit.
# Any intentional circuit change must update artifacts/circuits/SHA256SUMS.
root="$(git rev-parse --show-toplevel)"
cd "$root/programs/privacy-cash"
circom_bin="${CIRCOM:-circom}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Checking pinned circuit sources and artifacts"
sha256sum --check --strict artifacts/circuits/SHA256SUMS

echo "Recompiling transaction2.circom"
test "$("$circom_bin" --version)" = 'circom compiler 2.2.3'
# The sources include ../scripts/node_modules/circomlib relative to circuits/.
npm ci --prefix scripts --ignore-scripts --no-audit --no-fund
"$circom_bin" circuits/transaction2.circom --r1cs --sym --output "$work"
cmp "$work/transaction2.r1cs" artifacts/circuits/transaction2.r1cs
cmp "$work/transaction2.sym" artifacts/circuits/transaction2.sym

echo "Checking transaction2.zkey against verifyingkey2.json"
npx --yes snarkjs@0.7.6 zkey export verificationkey \
  artifacts/circuits/transaction2.zkey "$work/verifyingkey.json"
python3 - "$work/verifyingkey.json" artifacts/circuits/verifyingkey2.json <<'PY'
import json
import sys

exported, committed = (json.load(open(path)) for path in sys.argv[1:])
if exported != committed:
    sys.exit("transaction2.zkey does not match verifyingkey2.json")
print("transaction2.zkey matches verifyingkey2.json.")
PY

python3 "$root/.github/scripts/check-verifying-key.py"
