# privacy-cash · mobile

A **transfer-only** React Native (Expo) companion to the privacy-cash web app.
Connect a wallet, load your shielded balance, and send a **private transfer** to
any address — gaslessly, via the relayer. The source note stays unlinkable to the
recipient, proven by a Groth16 zero-knowledge proof.

> Deposit and withdraw are **not** in this app — they live on the web app. Mobile
> is for spending your shielded notes on the go.

## Why a WebView bridge? (read this first)

`privacy-cash-sdk` cannot run in React Native's **Hermes** engine. It depends on:

- **WASM** — snarkjs (Groth16 witness/proof) + `@lightprotocol/hasher.rs` (Poseidon)
- **Web Crypto** — `crypto.subtle` (AES-256-GCM note encryption, key derivation)

Hermes has neither. So the SDK runs inside a **hidden WebView** (a real browser:
WASM ✓, `crypto.subtle` ✓), and the RN layer drives it over a `postMessage` RPC
channel. The native wallet (Mobile Wallet Adapter) lives in RN; only `signMessage`
is bridged into the page. See [`bridge/README.md`](bridge/README.md) for the wire
protocol.

```
RN (Hermes)  ──call──►  WebView (browser) ── privacy-cash-sdk (WASM + subtle)
   ▲ postMessage(result)        │
   │                           │ signer.signMessage() ──► RN wallet (MWA) ──► back
```

A relayed transfer needs only `signMessage` (to derive the shielded key) — no
`signTransaction`, since the relayer signs and broadcasts.

## Project layout

```
mobile/
  index.ts                  polyfill + registerRootComponent
  app.json, package.json, tsconfig.json, babel/metro config
  bridge/                   ← the SDK WebView bridge
    build-bridge.mjs        esbuild SDK → dist/bridge.html (+ bridge-html.ts)
    bridge-host.js          in-page RPC host (fetch override, bridged signer)
  src/
    App.tsx                 providers + router
    store.ts                zustand (settings persisted, runtime in-memory)
    wallet/WalletProvider   Mobile Wallet Adapter (connect / signMessage)
    bridge/SdkWebView       hidden WebView + RPC + sign round-trip
    bridge/BridgeContext    useBridge() → call(method, args)
    screens/                Connect, Home, Transfer, Settings
    ui/                     theme + components
    lib/                    rpc types, base64 utils
```

## Prerequisites

- **Node + Bun** (the monorepo uses Bun workspaces).
- **Android Studio** (emulator) or an **Android device**, or Xcode + iOS device.
  Expo Go is **not** enough — MWA needs a custom dev build.
- A **Solana wallet** on the device (Phantom or Solflare).
- The **privacy-cash dev stack running on your dev machine**: surfpool (:8899),
  the backend (:8080), and the **frontend dev server** (:5173 — it serves the
  proving circuit files at `/circuit/*`).

## Setup

All commands from the repo root unless noted.

```bash
# 1. install deps (links the sdk workspace + installs mobile's deps)
bun install

# 2. build the SDK (the bridge bundles its dist)
(cd sdk && bun run build)

# 3. build the WebView bridge (esbuild → mobile/bridge/dist/bridge.html)
cd mobile && bun run build:bridge
```

## Configure the LAN address

On a device/emulator, `localhost` means the phone itself. Point the app at your
**dev machine's LAN IP**. Find it:

```bash
ipconfig getifaddr en0        # macOS Wi-Fi
```

Then either edit `mobile/src/store.ts` `DEFAULTS`, or (easier) launch the app and
open **Settings**:

- **Backend URL** — `http://<LAN-IP>:8080` (relayer + indexer)
- **Circuit base** — `http://<LAN-IP>:5173` (serves `/circuit/transaction2.{wasm,zkey}`)

## Run the app

```bash
cd mobile
bun start            # expo start --dev-client
# in another terminal, build & launch the dev client:
npx expo run:android # (or :ios)  — first run builds the native shell
```

Connect your wallet, approve the signature, pull to refresh to load shielded notes.

## How to test a private transfer

The app spends **existing shielded notes**, so you need funds in the pool first.

1. On the **web app**, deposit SOL with **wallet A** (the same wallet you'll use
   on mobile). The deposit derives a shielded key from wallet A's signature.
2. On **mobile**, connect **wallet A** (same wallet → same signature → same
   shielded key, so it can see and spend those notes). Pull to refresh.
3. Tap **Send private transfer**, paste wallet B's address, enter an amount, send.
   Approve the signature prompt. The SDK builds the proof in the WebView and the
   **relayer** broadcasts it (the phone never submits the on-chain tx).
4. Wallet B receives public SOL; the source is unlinkable.

> The phone wallet's cluster doesn't need to match surfpool — `signMessage` is
> off-chain. Only the relayer talks to surfpool.

## Known integration points (verify on a device)

The architecture is sound and the SDK is proven on web, but the **WebView
hosting layer** has three mobile-specific points that need a real device pass:

1. **`crypto.subtle` secure context.** Web Crypto is only available on a secure
   origin. For `source={{ html }}` the origin is `about:blank`, which modern
   Android System WebView treats as trustworthy — but if `status`/`ready` reports
   `webcrypto:false`, load the page from `file://` (bundle `bridge.html` as an
   asset) instead. The Home screen shows a banner if this fails.
2. **`hasher.rs` WASM load.** The build inlines `.wasm` as data URIs. If the
   Poseidon WASM rejects a data URI, the failure surfaces on the first SDK call —
   adjust the loader at that point.
3. **CORS.** The LAN backend must allow the WebView origin (`*` for dev). The
   `frontend/scripts/backend-shim.mjs` should send permissive CORS headers; the
   Rust backend needs the same for mobile testing.

## Scope & non-goals

- ✅ Connect wallet (MWA), unlock, load shielded balance, private transfer, history.
- ❌ Deposit / withdraw (use the web app).
- ❌ SPL transfers (SOL only for v1; `transferSPL` exists in the SDK if needed).

## Rebuilding after SDK changes

Whenever the SDK changes:

```bash
(cd sdk && bun run build) && (cd mobile && bun run build:bridge)
```

The bridge bundles a snapshot of `sdk/dist`, so it must be rebuilt to pick up
changes (mirrors the web frontend's Vite-cache caveat).
