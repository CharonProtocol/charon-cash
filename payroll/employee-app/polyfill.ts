// React Native (Hermes) lacks a few globals that @solana/web3.js expects.
// NOTE: this only polyfills the *thin* RN layer (base58 / PublicKey / tx plumbing
// for the wallet). The heavy SDK work (snarkjs WASM, Poseidon, crypto.subtle,
// Groth16 proof) does NOT run here — it runs inside the hidden WebView bridge,
// which is a full browser environment. See bridge/README.md.
import { Buffer } from "buffer";

if (typeof (globalThis as any).Buffer === "undefined") {
  (globalThis as any).Buffer = Buffer;
}
