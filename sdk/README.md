# privacy-cash-sdk

Browser-native client SDK for **Privacy Cash** — zero-knowledge private payments on Solana. Client-side Groth16 proofs, a Poseidon Merkle pool, gasless relayer withdrawals, and multi-asset (SOL + SPL) support. The wallet signs everything client-side; private keys never leave the device.

[![npm version](https://img.shields.io/npm/v/privacy-cash-sdk.svg)](https://www.npmjs.com/package/privacy-cash-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔒 **100% client-side ZK** — Groth16 proofs generated in the browser via `snarkjs`/WASM. No private data leaves the device.
- 🌲 **Poseidon Merkle pool** — 26-level tree (~67M commitments), 100-root history, nullifier set, Groth16 over BN254.
- 💸 **Gasless withdrawals** — relayer signs + submits on your behalf (default), so a recipient with 0 SOL can still be paid.
- 🪙 **SOL + SPL** — native SOL and any SPL token (USDC, USDT, custom mints), each mint in its own tree.
- 🔑 **Self-custodial** — the SDK holds no keys; the wallet derives the shielded spending key via a signature.
- 🧩 **Two submit modes** — `relay: true` (gasless, default) or `relay: false` (you sign + pay gas, censorship-resistant).

## Install

```bash
npm install privacy-cash-sdk
# or: bun add privacy-cash-sdk / yarn add privacy-cash-sdk
```

That's it — `@solana/web3.js`, `@solana/spl-token`, `snarkjs`, etc. come along automatically as dependencies. (If your app already uses `@solana/web3.js`, npm/bun will dedupe to a single copy — just keep the version compatible.)

## You also need

- **The Privacy Cash backend** running (the Rust `privacy-cash-backend`) — it indexes the chain (Yellowstone gRPC) and serves the read/relay endpoints (`/api/merkle`, `/api/relayer/*`, `/api/utxos`, …). The SDK talks only to this backend.
- **The Privacy Cash program** deployed + the pool initialized on your network (devnet/mainnet/local).
- **Circuit files** — the browser fetches `/circuit/transaction2.{wasm,zkey}` by default (ship them in your app's `public/`). In Node, preload them with `setCircuitBuffers(wasm, zkey)`.

## Quick start

```ts
import { PrivacyCashClient, setBackendUrl } from "privacy-cash-sdk"

// Point at your backend (or set VITE_BACKEND_URL and skip this).
setBackendUrl("https://your-backend.example.com")

// Build a Signer from any wallet (example: @solana/wallet-adapter-react).
// Signer = { publicKey, signMessage, signTransaction }
const client = new PrivacyCashClient(
  { publicKey, signMessage, signTransaction },
  // programId is optional — fetched from the backend if omitted
)

// Prompts the wallet to sign a message → derives your shielded spending key.
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
// Withdraw to an address — defaults to GASLESS (relay: true):
const wd = await client.withdrawSOL(0.5e9, recipientPublicKey)
console.log(wd.recipientLamports, wd.feeLamports)

// Transfer = withdraw to someone ELSE's address (same call, default gasless):
await client.transferSOL(0.3e9, anotherAddress)

// Self-signed + you pay gas (censorship-resistant; you can broadcast via any RPC):
await client.withdrawSOL(0.5e9, recipient, { relay: false })
```

### Send privately to a public address (deposit + gasless withdraw in one call)

```ts
// Deposits from your wallet, then the relayer gasless-withdraws to the recipient.
// Your deposit is unlinkable to the recipient via ZK.
await client.sendPrivateSOL(0.5e9, recipientAddress)
```

### Scan + balance

```ts
await client.syncNotes("sol")                // decrypt your owned notes from the backend
const bal = client.getPrivateBalanceSOL()    // bigint, lamports
const usdcBal = client.getPrivateBalanceSPL(usdcMint)
```

## `relay` modes

Every withdraw/transfer/send takes an optional `{ relay?: boolean }` (default **`true`**).

| | `relay: true` (default) | `relay: false` |
|---|---|---|
| Signs the tx | the relayer | **your wallet** |
| Pays gas | relayer (takes a fee from the pool) | you |
| Needs SOL for gas | no | yes |
| Censorship resistance | depends on relayer | **yes — you can submit the signed tx via any RPC** |

Use `relay: true` for smooth gasless UX (the common case). Use `relay: false` when you want maximum self-sovereignty / no trust in the relayer key.

> Privacy is identical in both modes (your deposit is unlinked via ZK). `relay` only changes *who signs + who pays gas*. Both pay the recipient in public SOL/SPL at a visible address — a fully shielded transfer (`ext_amount = 0`, recipient gets a private note) is a separate, upcoming mode.

## API

| method | description |
|---|---|
| `new PrivacyCashClient(signer, programId?)` | construct (signer = `{ publicKey, signMessage, signTransaction }`) |
| `unlock()` | wallet signs → derives shielded key + syncs notes |
| `depositSOL(lamports)` / `depositSPL(mint, raw)` | shield funds into the pool |
| `withdrawSOL(lamports, recipient, opts?)` / `withdrawSPL(...)` | spend a note to an address (default gasless) |
| `transferSOL(lamports, recipient, opts?)` / `transferSPL(...)` | alias: spend a note to someone else's address |
| `sendPrivateSOL(lamports, recipient, opts?)` / `sendPrivateSPL(...)` | deposit + gasless withdraw-to-recipient |
| `syncNotes(treeKey, fromScratch?)` | scan + decrypt your notes from the backend |
| `getPrivateBalanceSOL()` / `getPrivateBalanceSPL(mint)` | private balance (bigint, lamports/raw) |
| `backupNotes()` / `restoreNotes()` | encrypted note blob backup/restore via the backend |

Module-level: `setBackendUrl(url)`, `getBackendUrl()`, `setCircuitBuffers(wasm, zkey)`.

## Build & test

```bash
bun run build     # tsc → dist/
bun test          # proof unit tests
```

## License

MIT
