# SDK WebView Bridge

React Native's Hermes runtime **cannot** run the privacy-cash SDK: the SDK needs
WASM (snarkjs Groth16 + `@lightprotocol/hasher.rs` Poseidon) and Web Crypto
(`crypto.subtle` for AES-GCM + key derivation), neither of which Hermes provides.

So the SDK runs inside a **hidden WebView** (a full browser engine: WASM ✓,
`crypto.subtle` ✓), and the React Native layer drives it over a `postMessage`
RPC channel. The native wallet (Mobile Wallet Adapter) lives in RN; only the
`signMessage` call is bridged into the page.

```
┌──────── React Native (Hermes) ────────────┐
│ UI · wallet (MWA) · signMessage            │
│         ▲ postMessage(result)              │
│         ▼ injectJavaScript(call)           │
└───────────────┬────────────────────────────┘
                │
┌───────────────▼── WebView (browser) ───────┐
│ bridge.html (self-contained)               │
│  · privacy-cash-sdk (snarkjs + Poseidon)   │
│  · crypto.subtle (AES key derive/encrypt)   │
│  · fetch override → LAN backend + /circuit │
└─────────────────────────────────────────────┘
```

## Build

From `mobile/`:

```bash
# 1. the SDK must be built first (resolves sdk/dist/index.js)
(cd ../sdk && bun run build)

# 2. bundle the bridge (esbuild → dist/bridge.html + dist/bridge-html.ts)
bun run build:bridge
```

`build-bridge.mjs` inlines the SDK bundle and `bridge-host.js` into a single
`dist/bridge.html`, and emits `dist/bridge-html.ts` (the HTML as a string) which
`src/bridge/SdkWebView.tsx` imports. The page is loaded with
`source={{ html }}` so it ships inside the app — no web server required for the
page itself.

## RPC protocol

RN → bridge (via `injectJavaScript`): `{id, type:"call", method, args}`
Bridge → RN (via `ReactNativeWebView.postMessage`):
- `{type:"ready"}` on load
- `{id, type:"result", ok:true, data}` / `{id, type:"result", ok:false, error}`
- `{type:"signRequest", signId, messageB64}` — bridge needs the wallet signature
RN → bridge: `{signId, type:"signResponse", signatureB64 | error}`

Methods: `status`, `unlock`, `refresh`, `getNotes`, `balance`, `transfer`,
`exportNotes`, `importNotes`.

## Configuration (injected before load)

`window.__PCASH_CONFIG__ = { walletPubkey, backendUrl, circuitBase }`
- `backendUrl` — the relayer/indexer base, e.g. `http://192.168.x.x:8080`
- `circuitBase` — host that serves `/circuit/transaction2.{wasm,zkey}`
  (the frontend dev server does: `http://192.168.x.x:5173`)

The fetch override rewrites relative `/circuit/*` to `circuitBase` so the proving
assets load from the LAN.

## Known integration risks (verify on a device)

These are the mobile-WebView frontier — correct by design, but must be confirmed
on a real device/emulator:

1. **`crypto.subtle` availability.** Web Crypto requires a *secure context*. For
   `source={{ html }}` the origin is `about:blank`, which recent Android System
   WebView (Chrome) treats as trustworthy, but older builds / iOS WKWebView may
   not. `bridge-host.js` self-checks and reports `webcrypto:false` on `ready` /
   `status`. **Fallback:** serve `dist/bridge.html` over the LAN from a host that
   is a secure context and load it by URL, or load via `file://` (also a secure
   context in WebView).
2. **WASM load for `@lightprotocol/hasher.rs`.** The build inlines `.wasm` as
   data URIs. If the lib rejects data-URI wasm, the failure surfaces as a
   `WasmFactory`/instantiate error on the first SDK call.
3. **CORS.** Fetches to the LAN backend must allow the WebView origin. The dev
   backend/shim should send permissive CORS headers for `*` during testing.

If `status` returns `webcrypto:false`, stop and fix the secure context before
anything else — no SDK call will work without it.
