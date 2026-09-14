#!/usr/bin/env bash
set -euo pipefail

# Pinned to the generator used by programs/Cargo.toml and README.md.
# The checksum comes from this release's published .sha256 asset.
install_dir="${RUNNER_TEMP:?}/qedgen-2.49.0"
mkdir -p "$install_dir"
curl --fail --silent --show-error --location --retry 3 \
  https://github.com/QEDGen/solana-skills/releases/download/v2.49.0/qedgen-x86_64-unknown-linux-gnu \
  --output "$install_dir/qedgen"
printf '%s  %s\n' \
  21346a1b285a2cf66a1d994bc7c9b6e2285bc49ee9844232f637c5ac0572ce30 \
  "$install_dir/qedgen" | sha256sum --check --strict
chmod +x "$install_dir/qedgen"
test "$("$install_dir/qedgen" --version)" = 'qedgen 2.49.0'
echo "$install_dir" >> "${GITHUB_PATH:?}"
