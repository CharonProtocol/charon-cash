# privacy-cash-sdk

Browser-native client SDK for **Privacy Cash** — zero-knowledge private payments on Solana. Groth16 proofs made on the user's device by a Rust prover compiled to wasm, a Poseidon Merkle pool, wallet-signed deposits/transfers/withdraws, and relayer-signed v1 private swaps. The wallet signs everything it can; private keys never leave the device.

[![npm version](https://img.shields.io/npm/v/privacy-cash-sdk.svg)](https://www.npmjs.com/package/privacy-cash-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔒 **Local Groth16** — arkworks compiled to wasm proves in a Web Worker (about 2 s on a laptop). The witness, which contains the spend key, never leaves the device; only the proof and seven public signals do. There is no prove endpoint.
- 🌲 **Poseidon Merkle pool** — 26-level tree (~67M commitments), 100-root history (one slot per completed instruction, ~100-tx window), nullifier set, Groth16 over BN254.
- 💸 **Wallet-signed withdraws** — your wallet signs Transact. Recipients with 0 SOL still get paid from the pool; you pay the tx fee.
- 🪙 **SOL + SPL** — native SOL and any SPL token (USDC, USDT, custom mints), each mint in its own tree.
- 🔑 **Self-custodial** — the SDK holds no keys; the wallet derives the shielded spending key via a signature.
- 🧩 **Relayer only for v1 swaps** — Phantom cannot sign v1 packets, so atomic Jupiter swaps are shim-signed.

## Install

```bash
npm install privacy-cash-sdk
# or: bun add privacy-cash-sdk / yarn add privacy-cash-sdk
```

That's it — `@solana/web3.js`, `@solana/spl-token`, etc. come along automatically as dependencies. (If your app already uses `@solana/web3.js`, npm/bun will dedupe to a single copy — just keep the version compatible.)

## You also need

- **The Privacy Cash backend** running (the Rust `privacy-cash-backend`) — it indexes the chain (Yellowstone gRPC) and serves the read/relay endpoints (`/api/merkle`, `/api/relayer/*`, `/api/utxos`, …). The SDK talks only to this backend.
- **The Privacy Cash program** deployed + the pool initialized on your network (devnet/mainnet/local).
- **The circuit files served by your app** at `/circuit/transaction2.zkey` (16 MB) and `/circuit/transaction2.graph` (0.86 MB), copied from `programs/privacy-cash/artifacts/circuits/`. The SDK checks both against pinned SHA-256 hashes (`CIRCUIT_ARTIFACTS`) and keeps them in Cache Storage, so they download once. Serve them from elsewhere with `configureProver({ circuitBaseUrl })`.
- **A bundler that handles `new Worker(new URL(...), import.meta.url)` and `.wasm` assets** (Vite, webpack 5, Parcel). With Vite, add `optimizeDeps: { exclude: ["privacy-cash-sdk"] }` and `worker: { format: "es" }`; pre-bundling rewrites the URLs the worker and wasm are loaded from.

## Quick start

```ts
import { PrivacyCashClient, setBackendUrl } from "privacy-cash-sdk"

// Point at your backend (or set VITE_BACKEND_URL and skip this).
setBackendUrl("https://your-backend.example.com")

// Build a Signer from any wallet (example: @solana/wallet-adapter-react).
// Signer = { publicKey, signTransaction, signIn } — unlock requires SIWS signIn
const client = new PrivacyCashClient(
  { publicKey, signMessage, signTransaction, signIn },
  // programId is optional — fetched from the backend if omitted
)

// Sign In With Solana (no nonce). Phantom binds `domain` to this page.
// keccak(signature) → shielded spend key. Same wallet + site + cluster → same key.
await client.unlock()
```

### Deposit (shield funds)

```ts
const dep = await client.depositSOL(0.5 * 1_000_000_000) // lamports
console.log(dep.signature, dep.leafIndex)

// SPL:
// await client.depositSPL(mintAddress, amountRaw)
```

### Withdraw / Transfer (spend a note)

```ts
// Withdraw to a public address. You prove locally; the relayer signs, pays and
// broadcasts, so your wallet is not in the transaction.
const wd = await client.withdrawSOL(0.5e9, recipientPublicKey)
console.log(wd.recipientLamports, wd.feeLamports)

// Shielded transfer: recipient gets a pool note (`extAmount = 0`), also relayed.
await client.transferSOL(0.3e9, anotherAddress)

// Smallest withdrawal that leaves the recipient anything after the relayer's fee.
client.minWithdrawalLamports()
```

### Send privately to a public address (deposit + withdraw in one call)

```ts
// Your wallet signs the deposit (it has to — the program funds it from the signer),
// then the relayer signs the withdrawal, so nothing links the two on-chain.
await client.sendPrivateSOL(0.5e9, recipientAddress)
```

### Scan + balance

```ts
await client.syncNotes("sol")                // decrypt your owned notes from the backend
const bal = client.getPrivateBalanceSOL()    // bigint, lamports
const usdcBal = client.getPrivateBalanceSPL(usdcMint)
```

## Note storage & recovery

Notes (the off-chain material needed to spend a shielded UTXO, including each
note's `blinding` secret) are **never persisted to the browser**. They live in
two places only:

- **In memory** — decrypted notes are held in a page-session cache while the
  wallet is unlocked, and wiped on reload.
- **On the backend, encrypted** — after every change the SDK encrypts the whole
  note set with the wallet-signature-derived AES-256-GCM key and `PUT`s an
  opaque blob to the backend (`encrypted_notes` table). The server stores only
  ciphertext and has **no key**.

On `unlock()` the SDK seeds the in-memory cache from that blob (`restoreNotes`)
and from a scan of the indexer's encrypted outputs (`syncNotes`). Use
`refreshNotes()` to re-pull + rescan, and `getNotes()` to read the decrypted
set. Import/clear go through `importNotesJson` / `clearAllNotes`, which also
persist to the backend.

**Recovery:** if the backend blob is ever lost, `syncNotes` rebuilds the note
set by decrypting the indexer's on-chain encrypted outputs — so a wallet can
always recover its funds by re-scanning. No plaintext note material is ever
written to `localStorage`.

## Who signs

| | deposits | withdraws / transfers | private swap |
|---|---|---|---|
| Signs the tx | **your wallet** | the relayer | the relayer (v1 packet) |
| Pays gas + rent | you | relayer, charged back as the fee | relayer |
| Why | the program funds a deposit from the signer, and a deposit is publicly attributable anyway | a wallet-signed spend names your wallet as fee payer beside the recipient and the amount | wallets cannot sign v1 packets yet |

A ZK proof hides which note you spent, but not who submitted the transaction. A
self-signed withdrawal puts your wallet on-chain next to the recipient and the
amount, which links your deposit to your withdrawal without breaking any
cryptography. That is why spends are relayed by default.

**The relayer cannot cheat you.** Recipient, amount, fee, fee recipient, mint and
both ciphertexts are hashed into `extDataHash`, a Groth16 public input the program
verifies. The relayer builds the transaction, but only one transaction hashes to
the proof you produced. Its complete set of powers is: refuse, delay, reorder, and
observe (recipient, amount, IP, timing).

**What it costs.** Every spend creates two nullifier marker accounts, about 0.0018
SOL of rent that is never recovered by anyone. The relayer fronts it and charges it
back as the fee, so relayed spends have a minimum size — see
`minWithdrawalLamports()`. Fewer, larger withdrawals cost less and leak less
timing.

### Self-relay escape hatch

If the relayer is down or censoring you, sign it yourself:

```ts
const client = new PrivacyCashClient(signer, programId, undefined, { selfRelay: true })
// or at runtime:
client.setSelfRelay(true)
```

The program's `verify_signer` accepts any signer, so this always works and your
funds can never be frozen by an unavailable relayer. You pay the nullifier rent
directly (so there is no fee floor), and you give up the privacy above: your wallet
is published as fee payer. It is a deliberate, tested path — not a fallback the SDK
will ever take on your behalf, because silently deanonymizing a user is worse than
failing.

`canRelay(isSpl)` reports whether relaying is available. SPL spends additionally
need the relayer to have an Address Lookup Table configured, since they do not fit
in a packet without one.

## API

| method | description |
|---|---|
| `new PrivacyCashClient(signer, programId?, unlock?, options?)` | construct; `unlock` is `{ domain, uri, chainId }` for SIWS, `options` is `{ selfRelay }` |
| `unlock()` | SIWS `signIn` only → shielded key + notes |
| `depositSOL(lamports)` / `depositSPL(mint, raw)` | shield funds into the pool |
| `withdrawSOL(lamports, recipient)` / `withdrawSPL(...)` | spend a note to a public address (relayer-signed) |
| `transferSOL(lamports, recipient)` / `transferSPL(...)` | shielded transfer: recipient gets a pool note (relayer-signed) |
| `sendPrivateSOL(lamports, recipient)` / `sendPrivateSPL(...)` | wallet-signed deposit + relayed withdraw-to-recipient |
| `setSelfRelay(on)` / `isSelfRelay()` / `canRelay(isSpl)` | escape hatch: sign spends with your own wallet |
| `minWithdrawalLamports(isSpl?)` | smallest withdrawal worth making at the current relayer fee |
| `swapPrivate({ fromMint, outMint, amountIn })` | atomic private swap — relayer-signed v1 |
| `syncNotes(treeKey, fromScratch?)` | scan + decrypt your notes from the backend |
| `refreshNotes()` | unlock + re-scan + persist the in-memory note set |
| `getPrivateBalanceSOL()` / `getPrivateBalanceSPL(mint)` | private balance (bigint, lamports/raw) |
| `getNotes()` | decrypted notes held in memory for this session |
| `exportNotesString()` / `importNotesJson(json, replace?)` | export / import notes (and persist to backend) |
| `clearAllNotes()` | wipe notes — in-memory cache + encrypted backend blob |
| `backupNotes()` / `restoreNotes()` | push / pull the encrypted note blob (the authoritative store) |

Module-level: `setBackendUrl(url)`, `getBackendUrl()`, `setRelayerUrl(url)`,
`getRelayerUrl()`. The relayer is a separate service in production (it holds a hot
key); `getRelayerUrl()` falls back to the backend URL, which is what the dev shim
serves.

### Prover

| function | description |
|---|---|
| `prove(input)` | Groth16 proof for a circuit-input object → `{ proofA, proofB, proofC, publicSignals }` (compressed 32/64/32 bytes). Runs in a Web Worker in browsers, in-thread elsewhere |
| `preloadProver()` | download, hash-check and parse the circuit files ahead of the first proof; `unlock()` calls it while the wallet prompt is open |
| `configureProver({ circuitBaseUrl?, inThread?, loadArtifacts?, wasm?, threads? })` | where the circuit files live; for Node/Bun, pass the wasm bytes and a `loadArtifacts` that reads the files from disk. `threads` caps the prover's worker count (default: all cores); `1` forces the single-threaded build |
| `proverThreads()` | threads the loaded prover uses (`1` = single-threaded build), or `null` before it has loaded |
| `terminateProver()` | stop the worker and free the parsed proving key (the wasm heap peaks at about 65 MB) |
| `loadCircuitArtifacts(baseUrl)` / `verifyArtifact(kind, bytes)` | the fetch + SHA-256 + Cache Storage step, exposed for custom loaders |

**Threads.** The package ships two builds of the prover. `prover-wasm-mt/` runs rayon
over Web Workers and proves in roughly a third of the time; `prover-wasm/` is
single-threaded. The threaded build needs `SharedArrayBuffer`, so the SDK uses it only
when `crossOriginIsolated` is true. That means the page must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them, or if the threaded build fails to start (a `console.warn` says why), the
SDK falls back to the single-threaded build, so proofs still work, only slower.
`require-corp` makes the browser refuse cross-origin subresources that lack CORS or
`Cross-Origin-Resource-Policy`, so give such `<link>`/`<img>`/`<script>` tags a
`crossorigin` attribute. Node and Bun always use the single-threaded build.

In Node or Bun there is no `/circuit/` to fetch, so configure the prover first
(this is what `frontend/scripts/local-prover.mjs` does):

```ts
import { readFileSync } from "node:fs"
import { configureProver, verifyArtifact } from "privacy-cash-sdk"

const dir = "programs/privacy-cash/artifacts/circuits"
configureProver({
  inThread: true,
  wasm: readFileSync("node_modules/privacy-cash-sdk/prover-wasm/privacy_cash_prover_bg.wasm"),
  loadArtifacts: async () => {
    const zkey = new Uint8Array(readFileSync(`${dir}/transaction2.zkey`))
    const graph = new Uint8Array(readFileSync(`${dir}/transaction2.graph`))
    await verifyArtifact("zkey", zkey)
    await verifyArtifact("graph", graph)
    return { zkey, graph }
  },
})
```

## Build & test

```bash
bun run build:prover   # wasm-pack: crates/privacy-cash-prover → prover-wasm/ + prover-wasm-mt/
                       # (needs wasm-pack, the wasm32 target, and nightly with rust-src for -mt)
bun run build          # tsc → dist/
bun test               # unit tests, including real Groth16 proofs with the wasm prover
```

## License

MIT
