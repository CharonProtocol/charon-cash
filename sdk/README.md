# charonprotocol-sdk

Browser SDK for Charon's private SOL and SPL payments. Proofs are generated on
the user's device with the Rust/WASM Groth16 prover. Deposit, withdrawal and
shielded transfer transactions use the connected wallet; private swaps use the
backend relayer.

## Local setup

From the repository root:

```bash
bun install --frozen-lockfile
bun run --cwd sdk build
bun run --cwd frontend dev
```

The frontend command verifies and copies the committed proving artifacts into
`frontend/public/circuit/`. Run the program, backend and indexer as described in
[`RUN.md`](../RUN.md) before using wallet operations. Registration and note API
requests currently use `API_URL` in `src/constants.ts` (`http://127.0.0.1:8080`);
relayer requests use `VITE_BACKEND_URL`. Set the program, ALT and fee-recipient
configuration to match the deployed program.

In Vite, exclude `charonprotocol-sdk` from dependency prebundling and use
`worker: { format: "es" }` so the prover's worker and WASM URLs are bundled.

## Client

```ts
import { CharonProtocol } from "charonprotocol-sdk";

// Obtain these three fields from the connected wallet.
const client = await CharonProtocol.generateClient({
  rpcUrl: "http://localhost:8899",
  owner: { publicKey, signMessage, signTransaction },
});

// Shield public SOL into a private note owned by your registered wallet.
const { signature } = await client.sendSol(100_000_000, publicKey.toBase58());

// Balance updates arrive after the indexer and background scanner see the note.
const unsubscribe = client.watchBalances(() => {
  const sol = client.utxoByMint.get("11111111111111111111111111111112");
  console.log(sol?.totalAmount.toString(), sol?.maxSingleTxAmount.toString());
});

// Later, withdraw private SOL back to the connected wallet.
await client.withdrawSol(50_000_000);

// On disconnect or page cleanup:
unsubscribe();
await client.stopClient();
```

Amounts are integer lamports for SOL and base units for SPL. Each spend can use
at most two notes; `maxSingleTxAmount` reports their combined spendable amount.
Recipients of private notes must be registered so their viewing key is available.

| Method | Behavior |
| --- | --- |
| `sendSol(amount, recipient)` | Shield public SOL into the recipient's private balance |
| `sendSpl(amount, recipient, mint)` | Shield a supported SPL token (currently USDC/USDT) |
| `withdrawSol(amount)` / `withdrawSpl(amount, mint)` | Withdraw to the connected wallet, with the protocol fee deducted |
| `shieldedTransferSol(amount, recipient)` / `shieldedTransferSpl(amount, mint, recipient)` | Transfer private notes to another registered wallet |
| `swap(fromMint, outMint, amount)` | Submit a private SOL/SPL swap through the relayer |
| `requestNoteScan()` | Wake the background scanner to fetch newly indexed outputs |
| `syncUtxos({ recoverMissing? })` | Load encrypted notes from browser storage into the in-memory balance |
| `watchBalances(listener)` | Subscribe to balance changes; returns an unsubscribe function |
| `stopClient()` | Stop the note scanner and close its storage connection |

## Note storage and recovery

The client derives encryption material from a wallet signature. Encrypted notes
and the per-wallet scan cursor are stored in IndexedDB; decrypted note summaries
are held in memory. The background worker fetches encrypted outputs, identifies
owned unspent notes and saves them locally.

`syncUtxos()` loads only notes after the in-memory cursor. To recover stored notes
missing from memory, call `syncUtxos({ recoverMissing: true })`. This scans the
local note store; it does not reset the backend scan cursor. Ordinary transactions
do not scan the wallet's entire store. On startup, an empty wallet store with an
advanced scan cursor resets to the first note for recovery.

## Prover

| function                                                                           | description                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prove(input)`                                                                     | Groth16 proof for a circuit-input object → `{ proofA, proofB, proofC, publicSignals }` (compressed 32/64/32 bytes). Runs in a Web Worker in browsers, in-thread elsewhere                                                 |
| `preloadProver()`                                                                  | download, hash-check and parse the circuit files ahead of the first proof                                                                                            |
| `configureProver({ circuitBaseUrl?, inThread?, loadArtifacts?, wasm?, threads? })` | where the circuit files live; for Node/Bun, pass the wasm bytes and a `loadArtifacts` that reads the files from disk. `threads` caps the prover's worker count (default: all cores); `1` forces the single-threaded build |
| `proverThreads()`                                                                  | threads the loaded prover uses (`1` = single-threaded build), or `null` before it has loaded                                                                                                                              |
| `terminateProver()`                                                                | stop the worker and free the parsed proving key (the wasm heap peaks at about 65 MB)                                                                                                                                      |
| `verifyArtifact(kind, bytes)`                    | validate an artifact against its pinned SHA-256 hash in custom loaders                                                                                                                                                      |

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
using the committed proving artifacts:

```ts
import { readFileSync } from "node:fs";
import { configureProver, verifyArtifact } from "charonprotocol-sdk";

const dir = "programs/privacy-cash/artifacts/circuits";
configureProver({
  inThread: true,
  wasm: readFileSync(
    "node_modules/charonprotocol-sdk/prover-wasm/privacy_cash_prover_bg.wasm",
  ),
  loadArtifacts: async () => {
    const zkey = new Uint8Array(readFileSync(`${dir}/transaction2.zkey`));
    const graph = new Uint8Array(readFileSync(`${dir}/transaction2.graph`));
    await verifyArtifact("zkey", zkey);
    await verifyArtifact("graph", graph);
    return { zkey, graph };
  },
});
```

## Build and test

Run from `sdk/`:

```bash
bun run build          # TypeScript → dist/
bun test               # encryption, storage, balance sync, real WASM proofs
bun run build:prover   # rebuild both committed WASM variants
```

Rebuilding the prover requires wasm-pack, the wasm32 target, and nightly with
rust-src for the threaded build. See [`RUN.md`](../RUN.md) for toolchain setup.

## License

MIT
