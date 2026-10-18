# Charon · mobile (Android)

The Charon wallet app: hold SOL and USDC privately, deposit, send, withdraw,
and receive Charon Payroll salaries. Devnet, against `backend.charon.cash`.
Swap shows a "coming with mainnet" notice (Jupiter has no devnet liquidity).

## How it works

```
RN (Hermes) --call--> hidden WebView (privacy-cash-sdk: Poseidon wasm, crypto.subtle)
   ^                     | signMessages / signTransaction --> wallet (Mobile Wallet Adapter)
   |                     | proveRequest -------------------> native arkworks prover (JNI)
   +---- result ---------+
```

- **SDK in a WebView.** Hermes has no WASM or Web Crypto, so the SDK runs in a
  hidden WebView loaded as `https://mobile.charon.cash/` (a secure context; it is
  also the Origin the backend allows: keep it in the VM's `ALLOWED_ORIGINS`).
- **Native prover.** Proofs run in Rust (`crates/privacy-cash-prover`,
  feature `android`), not in the WebView. The circuit ships inside the APK, so
  nothing is downloaded. `modules/charon-prover` is the Expo module around it.
- **Wallet.** One MWA session signs both unlock messages (one approval), and
  nothing opens the wallet on launch; the saved token rides on the next request.
  A new user approves 2 requests to sign in (unlock + enrollment); a returning
  session approves 1 per app start.

## Build

```bash
(cd sdk && bun run build)                     # the bridge bundles sdk/dist
cd mobile
bun install
modules/charon-prover/build-native.sh         # Rust .so (arm64 + x86_64) + circuit into the module
bun run build:bridge                          # SDK -> bridge/dist/bridge.html
bunx expo prebuild --platform android         # only if android/ is missing
(cd android && ./gradlew assembleRelease)     # app/build/outputs/apk/release/app-release.apk
```

Needs the Android NDK, `cargo-ndk` and the `aarch64-linux-android` /
`x86_64-linux-android` Rust targets. Keep `src/` 100% ASCII: hermesc silently
drops string literals with non-ASCII characters.

Rebuild the bridge after any SDK change; rebuild the native module after any
prover or circuit change.
