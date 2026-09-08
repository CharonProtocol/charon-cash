#!/bin/zsh
# One command: install missing tools, build the program + prover, start the
# chain, run the full 210-employee private-payroll bench.
#
#   zsh run-210.sh
#
# Wall time adapts to the machine: the bench auto-sizes the prover pool as
# min(16, (RAM GB - 3)/1.25, cores*0.75). An 8GB/8-core laptop runs 4 provers
# and lands ~13s; a 32GB/12-core box gets 9 provers and lands well under.
# Requires zsh (reset-env.sh uses zsh-only parameter expansion).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd ../../.. && pwd)"
TXV1_FEATURE="txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4"

say() { printf '\n== %s\n' "$*" >&2 }
have() { command -v "$1" >/dev/null 2>&1; }

# 1. tools -----------------------------------------------------------------
if ! have bun; then
  say "installing bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
have bun || { echo "bun install failed"; exit 1; }

if ! have solana || ! have solana-keygen || ! have cargo-build-sbf; then
  say "installing Solana CLI (agave stable; ships cargo-build-sbf)"
  curl -sSfL https://release.anza.xyz/stable/install | sh
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi
have solana && have cargo-build-sbf || { echo "solana CLI install failed"; exit 1; }
[ -f ~/.config/solana/id.json ] || solana-keygen new --no-bip39-passphrase

if ! have cargo; then
  say "installing rust (stable toolchain)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  export PATH="$HOME/.cargo/bin:$PATH"
fi
have cargo || { echo "rust install failed"; exit 1; }

# v1 transactions (4096B, no ALTs) need surfpool >= 1.5.0 started with the
# txv1 feature flag; older builds silently cap txs at the legacy 1232 bytes.
# brew's tap is stuck at 1.0.0 - upgrades come from the official installer.
spver() { "$1" --version 2>/dev/null | awk '{print $2}'; }
sp_good() { # $1 = candidate binary: version >= 1.5.0 and a --feature flag
  [[ -x "$1" ]] || return 1
  local v minor
  v=$(spver "$1")
  [[ "$v" == <1->.* ]] || return 1
  minor=${v#*.}; minor=${minor%%.*}
  (( ${v%%.*} > 1 || minor >= 5 )) || return 1
  "$1" start --help 2>&1 | grep -q -- --feature
}
SURFPOOL_RESOLVED=""
for cand in "$(command -v surfpool 2>/dev/null || true)" \
            "$HOME/.local/share/surfpool150/surfpool"; do
  if sp_good "$cand"; then SURFPOOL_RESOLVED="$cand"; break; fi
done
if [[ -z "$SURFPOOL_RESOLVED" ]]; then
  say "installing surfpool v1.5+ (official installer, run.surfpool.run)"
  curl -sL https://run.surfpool.run/ | bash
  export PATH="$HOME/.local/bin:$PATH"
  if sp_good "$HOME/.local/bin/surfpool"; then SURFPOOL_RESOLVED="$HOME/.local/bin/surfpool"; fi
fi
[[ -n "$SURFPOOL_RESOLVED" ]] || {
  echo "could not get surfpool >= 1.5.0 (needed for txv1 4096B txs)."
  echo "manual install: https://github.com/solana-foundation/surfpool"
  exit 1
}
echo "surfpool $(spver "$SURFPOOL_RESOLVED") at $SURFPOOL_RESOLVED"

# 2. js deps ---------------------------------------------------------------
say "bun install (bench deps; the SDK comes from ../../sdk via file:)"
(cd "$REPO/payroll/rust-prover-bench/bench" && bun install)

# 3. program keypair + declare_id + builds ----------------------------------
KP="$REPO/target/deploy/privacy_cash-keypair.json"
mkdir -p "$REPO/target/deploy"
[ -f "$KP" ] || solana-keygen new --no-bip39-passphrase --silent -o "$KP"
PROG_ID=$(solana-keygen pubkey "$KP")
LIB="$REPO/programs/privacy-cash/src/lib.rs"
if ! grep -q "\"$PROG_ID\"" "$LIB"; then
  say "pointing declare_id at this machine's program keypair ($PROG_ID)"
  sed -i.bak -E "s/declare_id!\(\"[A-Za-z0-9]+\"\)/declare_id!(\"$PROG_ID\")/" "$LIB" && rm -f "$LIB.bak"
fi
say "building program (cargo build-sbf) and prover-server (release)"
(cd "$REPO/programs/privacy-cash" && cargo build-sbf --sbf-out-dir "$REPO/target/deploy")
if have rustup; then
  (cd "$REPO/payroll/rust-prover-bench" && cargo +stable build --release --bin prover-server)
else
  (cd "$REPO/payroll/rust-prover-bench" && cargo build --release --bin prover-server)
fi

# 4. relayer secrets (fresh machine only; never printed) ---------------------
DV="$REPO/workers/.dev.vars"
if [ ! -f "$DV" ]; then
  say "creating workers/.dev.vars (fresh relayer keypair + admin password)"
  REL_KP=$(mktemp /tmp/relayer-kp.XXXXXX.json)
  solana-keygen new --no-bip39-passphrase --silent --outfile "$REL_KP" >/dev/null
  {
    echo "RELAYER_KEYPAIR_JSON=$(tr -d '\n' < "$REL_KP")"
    echo "SOLANA_RPC_URL=http://localhost:8899"
    echo "ADMIN_PASSWORD=$(openssl rand -hex 16)"
  } > "$DV"
  rm -f "$REL_KP"
fi

# 5. chain + backend + replica ----------------------------------------------
export SURFPOOL_BIN="${SURFPOOL_BIN:-$SURFPOOL_RESOLVED}"
export SURFPOOL_FLAGS="--feature $TXV1_FEATURE"
say "resetting env: surfpool, program deploy, D1, wrangler dev, proxy"
# reset-env.sh is repo-root-relative (target/deploy, workers/, payroll/...)
(cd "$REPO" && zsh payroll/rust-prover-bench/bench/reset-env.sh)

# 6. the bench ----------------------------------------------------------------
CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc)
ARK_THREADS=$(( CORES >= 12 ? 3 : 2 ))
export PROGRAM_ID="$PROG_ID"
say "running 16 pools x 210 employees ($CORES cores, $ARK_THREADS ark threads/prover)"
time env BATCH5=1 ARK_THREADS=$ARK_THREADS bun run-batch-v1.mjs 16 210

say "done - per-run JSON lives in /tmp/pfast-v1"
echo "the story: payroll/SPEED-JOURNEY.html"
