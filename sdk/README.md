# privacy-cash-sdk

Browser-native client SDK for **Privacy Cash** — Zero-Knowledge private transactions on Solana using client-side Groth16 ZK-SNARKs and gasless relayer withdrawals.

[![npm version](https://img.shields.io/npm/v/privacy-cash-sdk.svg)](https://www.npmjs.com/package/privacy-cash-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🔒 **100% Client-Side ZK Proofs**: Groth16 witness generation using `snarkjs` in browser WebAssembly. Zero private keys leave your device.
- ⚡ **Gasless Relayer Payouts**: Withdraw funds directly into a fresh target address with 0 SOL balance. Relayer pays network gas.
- 🌲 **On-Chain Merkle Tree**: 20-level binary Poseidon tree with up to 1,048,576 commitments per pool.
- 🪙 **Multi-Asset Support**: Full support for native SOL and SPL Tokens (USDC, USDT, Custom mints).
- 🔑 **Local Note Vault**: Encrypted commitment notes stored safely in local storage per wallet address.

## Installation (using Bun)

```bash
bun add privacy-cash-sdk @solana/web3.js
```

or with npm / yarn:

```bash
npm install privacy-cash-sdk @solana/web3.js
```

## Quick Start

### 1. Initialize Client & Unlock Vault

```typescript
import { PrivacyCashClient } from "privacy-cash-sdk";
import { Connection } from "@solana/web3.js";

const connection = new Connection("https://api.devnet.solana.com");
const client = new PrivacyCashClient({
  connection,
  backendUrl: "https://relayer.privacy.cash",
  wallet: window.solana, // Phantom or standard Wallet Adapter
});

// Prompt wallet to sign initialization message (derives encryption keys)
await client.unlock();
```

### 2. Shielded SOL Deposit

```typescript
import { solToLamports } from "privacy-cash-sdk";

// Deposit 0.5 SOL into the shielded pool
const depositResult = await client.depositSOL(solToLamports(0.5));

console.log("Deposit Signature:", depositResult.signature);
console.log("Merkle Leaf Index:", depositResult.leafIndex);
```

### 3. Gasless Private Withdrawal

```typescript
// Withdraw to a fresh unlinked target address with 0 SOL balance
const withdrawResult = await client.withdrawSOL({
  amountLamports: solToLamports(0.5),
  recipientAddress: "CleanTargetAddressHere1111111111111111111111",
  useRelayer: true, // Gasless execution
});

console.log("Relayed Transaction Signature:", withdrawResult.signature);
```

## Build & Test with Bun

```bash
# Build SDK to dist/
bun run build

# Run unit tests
bun test
```

## Security

Privacy Cash uses Poseidon hashing for commitment leaves and nullifier hashes. ZK proofs are generated off-chain using Groth16 over the BN254 elliptic curve and verified on-chain by the Privacy Cash Anchor program on Solana.

## License

MIT © Privacy Cash Team
