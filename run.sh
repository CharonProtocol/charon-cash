#!/usr/bin/env bash
# Start the full privacy-cash local stack — one command, idempotent, from a
# fresh clone (macOS or Linux):
#   deps + SDK build · surfpool (--offline) · program build+deploy · tree init
#   · backend (with recipient registry) · frontend (:5173) · payroll app (:5174)
# Safe to re-run any time; each step heals only what is missing/broken.
# Logs: /tmp/privacy-cash-{install,sdk-build,build,surfpool,backend,frontend,payroll}.log
set -u
cd "$(dirname "$0")"
ROOT="$PWD"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

L=/tmp/privacy-cash
PAYER_KEYPAIR="$HOME/.config/solana/id.json"
RECIPIENTS_FILE="$ROOT/payroll/.local-recipients.json"

rpc_up() { curl -s -m2 -X POST http://localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"ok"'; }
wait_http() { local url="$1" i; for i in $(seq 1 60); do curl -s -m2 -o /dev/null "$url" 2>/dev/null && return 0; sleep 1; done; return 1; }
wait_rpc() { local i; for i in $(seq 1 60); do rpc_up && return 0; sleep 1; done; return 1; }
# PIDs listening on a TCP port, IPv4 or IPv6 (lsof on macOS, ss on Linux)
port_pids() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2
  fi | sort -u
}
# free_port <port> <regex of our programs>: stop leftovers of this stack (from
# any checkout, e.g. the Rust backend from RUN.md), refuse to touch anything
# else. Two servers can share a port (one IPv4, one IPv6): 127.0.0.1 and
# localhost then reach different backends — the app shows "not enrolled" for
# wallets the other backend registered, and payouts look missing.
free_port() {
  local port="$1" ours="$2" pid cmd i
  for pid in $(port_pids "$port"); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null)
    if echo "$cmd" | grep -Eq "$ours"; then
      echo "    stopping leftover on :$port (pid $pid): ${cmd:0:100}"
      kill "$pid" 2>/dev/null
    else
      echo "    ✗ port $port is used by another program (pid $pid): ${cmd:0:120}"
      echo "      stop it (kill $pid) and re-run ./run.sh"
      return 1
    fi
  done
  for i in $(seq 1 20); do [ -z "$(port_pids "$port")" ] && return 0; sleep 0.5; done
  for pid in $(port_pids "$port"); do kill -9 "$pid" 2>/dev/null; done
  sleep 1
  [ -z "$(port_pids "$port")" ] || { echo "    ✗ could not free port $port"; return 1; }
}
SHA256="shasum -a 256"; command -v shasum >/dev/null 2>&1 || SHA256=sha256sum

echo "▶ 0/7  Tools + dependencies…"
MISSING=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "    ✗ $1 not found — install: $2"; MISSING=1; }; }
need curl "your package manager (apt/dnf/brew install curl)"
need perl "your package manager (apt/dnf/brew install perl)"
need bun "curl -fsSL https://bun.sh/install | bash"
need cargo "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
need solana 'sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
need surfpool "curl -sL https://run.surfpool.run/ | bash"
[ "$MISSING" = 0 ] || { echo "    then open a new terminal and re-run (bench-kit/run-test.sh offers to install them)"; exit 1; }
if [ ! -f "$PAYER_KEYPAIR" ]; then
  mkdir -p "$(dirname "$PAYER_KEYPAIR")"
  solana-keygen new --no-bip39-passphrase --silent -o "$PAYER_KEYPAIR" && echo "    created local payer keypair $PAYER_KEYPAIR"
fi
bun install > "$L-install.log" 2>&1 || { echo "    ✗ bun install failed (log $L-install.log)"; tail -8 "$L-install.log"; exit 1; }
# payroll links sdk/dist file by file at install time: build the SDK first.
# Rebuilt only when its source changed; Vite's pre-bundle cache would keep
# serving the old one, so it goes too.
SDK_HASH=$( (cat sdk/package.json sdk/tsconfig.json; find sdk/src -type f | sort | xargs cat) | $SHA256 | cut -d' ' -f1)
if [ ! -f sdk/dist/index.js ] || [ "$(cat node_modules/.charon-sdk.src 2>/dev/null)" != "$SDK_HASH" ]; then
  (cd sdk && bun run build) > "$L-sdk-build.log" 2>&1 || { echo "    ✗ SDK build failed (log $L-sdk-build.log)"; tail -8 "$L-sdk-build.log"; exit 1; }
  echo "$SDK_HASH" > node_modules/.charon-sdk.src
  rm -rf payroll/node_modules/.vite frontend/node_modules/.vite
  echo "    SDK built"
fi
(cd payroll && bun install) >> "$L-install.log" 2>&1 || { echo "    ✗ payroll install failed (log $L-install.log)"; tail -8 "$L-install.log"; exit 1; }
echo "    ok: bun $(bun --version), $(surfpool --version 2>/dev/null)"

echo "▶ 1/7  Surfpool (local Solana, :8899, --offline)…"
if rpc_up; then echo "    already running"
else
  pkill -f '[s]urfpool' 2>/dev/null; sleep 1
  # GEYSER_CONFIG=~/yellowstone/config.json loads the Yellowstone gRPC plugin
  # (:10000) so backend-fast can stream (start it with GRPC_URL)
  nohup surfpool start --offline ${GEYSER_CONFIG:+-g "$GEYSER_CONFIG"} > "$L-surfpool.log" 2>&1 &
  disown
  echo "    starting (log $L-surfpool.log)…"
  wait_rpc || { echo "    ✗ surfpool didn't come up — check $L-surfpool.log"; exit 1; }
fi
echo "    up"

echo "▶ 2/7  Program keypair + declare_id…"
mkdir -p target/deploy
[ -f target/deploy/privacy-cash-program.json ] || solana-keygen new --no-bip39-passphrase --silent -o target/deploy/privacy-cash-program.json
PROG=$(solana-keygen pubkey target/deploy/privacy-cash-program.json)
# Build with declare_id = this machine's program key, then put lib.rs back as
# it was, so the checkout stays clean and `git pull` keeps working.
LIB=programs/privacy-cash/src/lib.rs
id_of() { perl -ne 'print $1 if /declare_id!\("([^"]+)"\);/'; }
set_id() { [ "$(id_of < "$LIB")" = "$1" ] || perl -0pi -e 's/declare_id!\("[^"]+"\);/declare_id!("'"$1"'");/' "$LIB"; }
ORIG_ID=$(id_of < "$LIB")
# an older run.sh left this machine's key in lib.rs: put the committed one back
[ "$ORIG_ID" = "$PROG" ] && ORIG_ID=$(git show "HEAD:$LIB" 2>/dev/null | id_of)
[ -n "$ORIG_ID" ] || ORIG_ID=$PROG
restore_lib() { set_id "$ORIG_ID"; }
trap restore_lib EXIT
set_id "$PROG"

echo "▶ 3/7  Program binary (build when the source changed)…"
# Fingerprint of the program source (declare_id included): a binary left over
# from another branch or checkout must never be reused — it decodes a
# different instruction layout ("invalid instruction data" on every deposit).
# Classic sBPF (v0) on purpose: newer CLIs can target sBPFv3, where the
# Poseidon syscall light-hasher 4.0.0 uses no longer exists (build error). The
# local chain accepts v0; the v3 migration is a separate dependency upgrade.
SBF_ARCH=v0
SRC_HASH=$( (echo "$SBF_ARCH"; cat programs/privacy-cash/Cargo.toml; find programs/privacy-cash/src -name '*.rs' | sort | xargs cat) | $SHA256 | cut -d' ' -f1)
if [ ! -f target/deploy/privacy_cash.so ] || [ "$(cat target/deploy/.privacy_cash.src 2>/dev/null)" != "$SRC_HASH" ]; then
  echo "    building (5-10 min on first run, log $L-build.log)…"
  rm -f target/deploy/privacy_cash.so
  cargo build-sbf --arch "$SBF_ARCH" --manifest-path "$ROOT/programs/privacy-cash/Cargo.toml" > "$L-build.log" 2>&1
  [ -f target/deploy/privacy_cash.so ] && echo "$SRC_HASH" > target/deploy/.privacy_cash.src
fi
restore_lib
[ -f target/deploy/privacy_cash.so ] || { echo "    ✗ build failed (log $L-build.log):"; tail -20 "$L-build.log"; exit 1; }
cp -f target/deploy/privacy_cash.so target/deploy/privacy-cash.so

echo "▶ 4/7  Deploy (or upgrade when the chain runs a different build)…"
deploy() {
  solana --url localhost --keypair "$PAYER_KEYPAIR" program deploy target/deploy/privacy-cash.so --program-id target/deploy/privacy-cash-program.json 2>&1 | grep "Program Id"
}
if solana --url localhost program show "$PROG" >/dev/null 2>&1; then
  solana --url localhost program dump "$PROG" "$L-onchain.so" >/dev/null 2>&1
  N=$(wc -c < target/deploy/privacy-cash.so | tr -d ' ')
  if head -c "$N" "$L-onchain.so" 2>/dev/null | cmp -s - target/deploy/privacy-cash.so; then
    echo "    $PROG already deployed (matches this build)"
  else
    echo "    on-chain program differs from this build — upgrading…"
    deploy || { solana --url localhost --keypair "$PAYER_KEYPAIR" program extend "$PROG" "$N" >/dev/null 2>&1; deploy; } || { echo "    ✗ upgrade failed — restart the chain: pkill -f 'surfpool start'; ./run.sh"; exit 1; }
  fi
else
  deploy || { echo "    ✗ deploy failed"; exit 1; }
fi

echo "▶ 5/7  Payer SOL + tree initialization…"
BAL=$(solana balance "$PAYER_KEYPAIR" --url localhost 2>/dev/null | grep -o '^[0-9]*' || echo 0)
if [ "${BAL:-0}" -lt 10 ]; then solana airdrop 100 "$PAYER_KEYPAIR" --url localhost >/dev/null 2>&1 && echo "    payer airdropped"; fi
cat > frontend/.env <<EOF
VITE_BACKEND_URL=http://localhost:8080
VITE_SOLANA_RPC_URL=http://localhost:8899
VITE_PROGRAM_ID=$PROG
EOF
# Preserve any existing ALT address across re-runs
if [ -f frontend/.env.local ]; then
  grep -E '^VITE_ALT_ADDRESS=' frontend/.env.local >> frontend/.env 2>/dev/null || true
fi
pkill -f '[b]ackend-(fast|shim).mjs' >/dev/null 2>&1; sleep 1
free_port 8080 'backend-(fast|shim)\.mjs|privacy-cash-backend|fast-indexer' || exit 1
( cd frontend && PROGRAM_ID="$PROG" RECIPIENTS_FILE="$RECIPIENTS_FILE" nohup env ${GEYSER_CONFIG:+GRPC_URL=http://127.0.0.1:10000 GRPC_COMMITMENT=processed} bun "scripts/backend-${BACKEND:-fast}.mjs" > "$L-backend.log" 2>&1 & )
wait_http http://localhost:8080/health || { echo "    ✗ shim failed (log $L-backend.log)"; exit 1; }
# The app's "Local simnet" uses 127.0.0.1, scripts use localhost: both must
# reach this backend (::1 is skipped where IPv6 is off).
for H in 127.0.0.1 localhost '[::1]'; do
  HEALTH=$(curl -s -g -m 3 "http://$H:8080/health" 2>/dev/null)
  [ -z "$HEALTH" ] && [ "$H" = '[::1]' ] && continue
  echo "$HEALTH" | grep -q "\"program\":\"$PROG\"" || {
    echo "    ✗ http://$H:8080 is answered by another server (${HEALTH:-no answer}), not this backend"
    echo "      see: lsof -nP -iTCP:8080 -sTCP:LISTEN"; exit 1; }
done
INIT=""
for i in $(seq 1 10); do
  INIT=$(curl -s -m 30 -X POST http://localhost:8080/api/relayer/initialize 2>/dev/null | head -c 200)
  echo "$INIT" | grep -q '"already-initialized"\|signature' && break
  sleep 2
done
TREE=$(curl -s -m 10 http://localhost:8080/api/merkle/sol 2>/dev/null)
echo "$TREE" | grep -q current_root && echo "    tree ready" || { echo "    ✗ tree init failed: $INIT"; exit 1; }

echo "▶ 6/7  Recipient registry…"
if [ -f "$RECIPIENTS_FILE" ]; then
  N=$(grep -c note_pubkey "$RECIPIENTS_FILE" 2>/dev/null || echo 0)
  echo "    $N enrolled wallets from payroll/.local-recipients.json"
else
  echo "    none yet — enroll wallets via the app (PUT /api/recipients) or seed $RECIPIENTS_FILE"
fi

echo "▶ 7/7  Apps: frontend (:5173) + payroll (:5174)…"
free_port 5174 'vite' || exit 1
# strictPort: if :5173 is taken the demo app fails alone instead of taking :5174
free_port 5173 'vite' || echo "    ⚠ demo app skipped (:5173 busy); payroll is unaffected"
( cd frontend && nohup bun run dev -- --port 5173 --strictPort > "$L-frontend.log" 2>&1 & )
( cd payroll && nohup bun run dev -- --port 5174 --strictPort > "$L-payroll.log" 2>&1 & )
wait_http http://localhost:5173 && echo "    frontend up" || echo "    ⚠ frontend failed (log $L-frontend.log)"
wait_http http://localhost:5174 && echo "    payroll up" || echo "    ⚠ payroll failed (log $L-payroll.log)"

# Optional native prover helper (NATIVE_PROVER=1): proves on this machine
# ~3x faster than the browser; pair it in the app's Settings with the code.
PAIR_LINE=""
if [ "${NATIVE_PROVER:-0}" = "1" ]; then
  echo "▶ +    Native prover helper (:8790)…"
  PS_BIN="$ROOT/crates/privacy-cash-prover/target/release/prover-server"
  [ -x "$PS_BIN" ] || cargo +stable build --release --bin prover-server --manifest-path "$ROOT/crates/privacy-cash-prover/Cargo.toml" 2>&1 | tail -1
  pkill -f '[p]rover-server' >/dev/null 2>&1; sleep 1
  PROVER_CODE="${PROVER_TOKEN:-$(openssl rand -hex 8)}"
  ( PROVER_TOKEN="$PROVER_CODE" nohup "$PS_BIN" > "$L-prover.log" 2>&1 & )
  wait_http http://127.0.0.1:8790/health && echo "    up" || echo "    ⚠ prover-server failed (log $L-prover.log)"
  PAIR_LINE="    native    paste this pairing code in Settings → Native prover pairing code: $PROVER_CODE"
fi

cat <<EOF

✅  all up — payroll: http://localhost:5174  (demo app: http://localhost:5173)
    Settings → "Local simnet" preset points the payroll app here.
    backend   http://localhost:8080   (program $PROG)
    rpc       http://localhost:8899   (surfpool --offline — resets on restart,
                                       run.sh redeploys/re-inits automatically)
    logs      /tmp/privacy-cash-{surfpool,backend,frontend,payroll,prover}.log
$PAIR_LINE

    fund your Phantom on surfpool:
      solana airdrop 100 <phantom-address> --url localhost
    (Phantom network = http://localhost:8899)
EOF
