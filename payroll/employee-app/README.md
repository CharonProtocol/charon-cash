# Payroll Employee (mobile)

Employee-side mobile app for private payroll: connect your wallet, enable
private receiving once, track shielded pay notes, and claim them back to
normal SOL in your wallet (gasless, via the relayer).

Lives only inside `payroll/` (not the main `mobile/` app). Forked from the
main mobile app's architecture:

- Expo + React Native (Hermes), Mobile Wallet Adapter for the wallet
  (Phantom / Solflare).
- The privacy-cash SDK runs inside a hidden WebView bridge (WASM + Web Crypto
  are unavailable in Hermes). See `bridge/README.md`.
- The RN layer talks to the bridge over postMessage RPC; wallet signature
  requests round-trip back to the native wallet.

## Employee flow

1. **Connect wallet** (MWA). The app resumes the persisted session silently.
2. **Enable private receiving** (one time, if the wallet has no registry
   entry): three signature approvals publish your note + encryption keys to
   the relayer's recipient registry. After this, employers can pay you with
   private notes.
3. **Track pay**: the app unlocks with one signature (spending key), scans
   the shielded pool for notes you own, and lists them with amount, leaf
   index and receive time. The wallet's public SOL balance shows beside it.
4. **Claim to wallet**: enter an amount (or MAX), see the relayer fee
   (`max(minFee, gross * bps / 10000)`) and the net, then claim. The proof is
   built in the WebView; the relayer broadcasts gaslessly and takes its fee
   off the gross. Your public SOL balance increases by the net.

## SDK note

`package.json` pins `privacy-cash-sdk` as `file:../../sdk` (the workspace
SDK), NOT the npm tarball: the recipient-registry API
(`publishRecipientKeys` / `fetchRecipientKeys`) the employee flow needs is in
the workspace source and not yet in the published package. `bun install`
copies the workspace SDK into `node_modules`, and `build:bridge` bundles it
into the WebView page. If you change `sdk/src`, re-run `bun install` (to
refresh the copy) then `bun run build:bridge`.

## Run it

```sh
cd payroll/employee-app
bun install
bun run build:bridge     # bundles the SDK into bridge/dist/bridge-html.ts
bun run typecheck
bun android              # expo run:android (prebuilds android/ on first run)
```

There is no `android/` directory committed; `bun android` (expo
run:android) generates it on first run.

## Local E2E (no phone needed)

`bridge/e2e-local.mjs` drives the REAL built bridge bundle in a Node/bun
harness with the RN wallet channel stubbed, against the local surfpool stack:

```sh
zsh payroll/rust-prover-bench/bench/reset-env.sh   # fresh chain first (see note)
cd payroll/employee-app
bun bridge/e2e-local.mjs
```

It walks: registry check (false) -> enable receiving (3 signature
round-trips) -> registry check (true) -> deposit -> unlock -> scan -> balance
-> claim 1 SOL (gasless relayer withdraw) -> verifies shielded balance, note
spend, and the wallet's on-chain SOL. Last measured: claim prove+relay 13-18 s,
relayer fee 25 bps (0.0025 SOL on 1 SOL).

NOTE reset first: the workers indexer only decodes 1-1 Transact txs, so any
batch3 smoke txs already on the chain leave the D1 mirror behind and later
deposits fail `UnknownRoot`. The 8788 chain-truth proxy also double-counts
leaves of failed transactions -- point clients at 8787, not the proxy.

## Settings

Defaults target the live devnet stack (Workers relayer + Vercel circuit
host). For a local surfpool payroll demo, set the Backend URL to the dev
machine's LAN address (phone and machine on the same network). Settings saves
remount the SDK WebView, so a new URL applies without reconnecting.

## Conventions (inherited from the main mobile app)

- Keep every file under `src/` and `bridge/bridge-host.js` 100% ASCII:
  hermesc silently drops string literals containing non-ASCII characters.
- The bridge polyfill import order in `build-bridge.mjs` is load-bearing
  (Buffer must exist before SDK module eval).
- The WebView needs `baseUrl: "https://localhost/"` for `crypto.subtle`.
- `windowBackground` stays pinned to `#0C0E12` in the native theme; screens
  use explicit heights, not flex:1 chains.
