# fast-payroll bench harness

Measures wall-clock time for a full payroll run (N employers x M employees)
against a local surfpool chain, using the arkworks prover-server pool
(`cargo build --release --bin prover-server` in the crate root).

- `proxy.mjs` — local merkle replica + chain-truth proxy. Replays the SDK's
  indexer endpoints (tree state, merkle proofs, utxo range, nullifier checks)
  from an in-memory tree built from the engine's own submitted txs, confirmed
  in landing order via `getSignaturesForAddress`. The chain stays the sole
  source of truth; `/local/verify` compares the replica root against the
  on-chain tree account after every run. "processed" confirmation counts as
  confirmed (surfpool can lag >10s at higher statuses under load, which used
  to starve the SDK's `locateNoteLeaf` window).
- `run.mjs` — the bench: airdrop -> register recipients -> deposits ->
  chained per-pool payouts -> verdict. Pools the prover-server processes
  (`ARK_PROVERS`, default 4), falls back to rapidsnark (`RAPIDSNARK_BIN`)
  or the SDK snarkjs prover when the binary is absent.
- `healNoteIndex` in run.mjs — after each hop, asks the proxy where the tx
  actually landed (`/local/sig/:sig`) and rewrites the change note's leaf
  index if the SDK's `locateNoteLeaf` kept a stale predicted index. Chained
  transfers never call `syncNotes`, so nothing else corrects it; uncorrected,
  the next hop proves a merkle path for someone else's leaf and fails with
  InvalidProof.
- `ark-oracle.mjs` — proves a fixture input through prover-server and
  verifies the proof with snarkjs against the ceremony verifying key
  (run under node, not bun: snarkjs web-worker crashes under bun).
- `zeros.mjs` — merkle zero table for HEIGHT=26 (used by proxy.mjs).

## Environment

1. surfpool on :8899 with the program deployed
   (`target/deploy/privacy-cash.so`, keypair `target/deploy/privacy-cash-keypair.json`),
   tree initialized (`POST /api/relayer/initialize` on the backend).
2. wrangler dev backend on :8787 (`workers/`, PROGRAM_ID var set).
3. `bun install` in this directory.
4. Build the prover: `cargo build --release --bin prover-server` (crate root).

## Run

```sh
bun proxy.mjs &                     # :8788
ARK_PROVERS=4 bun run.mjs 16 210 5000000   # pools, employees, pay-lamports
```

Pay is sized 5,000,000 lamports: the encrypted-note text length grows with
the amount's digit count and the wire tx must stay under Solana's 1232-byte
limit (enc1+enc2 <= 214 bytes at this size).

## Measured (2026-08-26, M1 Air 4P+4E / 8GB, 16 pools x 210 employees)

| config | pay wall |
|---|---|
| relayer-built proofs from D1 mirror | 902 s |
| client-built proofs + client-signed txs | 271 s |
| + lane tuning (4-way prove cap) | 230 s |
| + local merkle replica + rapidsnark | 126.4 s |
| + arkworks prover-server pool (4x1 thread) | **81.3 s** |
| + batch3 circuit, 2 employees/proof (v0 txs) | 30.9 s |
| + v1 txs, 3 transacts/tx, ARK_THREADS=2 | **17.7 s** |

81.3s detail: 226 proofs (210 pays + 16 deposits), p50 1.42s, prove CPU
318.7s / 4 provers = 79.7s floor (98% prove-bound), 0 lane failures,
replica root == chain root. 6 provers swap-thrash this machine (one proof
stretched to 902s) — 4 is the ceiling here.

## v1 transactions (SIMD-0385, 4096-byte txs)

Surfpool >= 1.5.0 can enable `enable_tx_v1`
(`--feature txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4`), which accepts the
4096-byte v1 wire format: no ALTs, no ComputeBudget ixs (CU/fee/heap are
config fields in the message), one signature, up to 64 addresses and 64
instructions per tx. That lets one tx carry 3 independent batch3 transacts
(6 employees) instead of 1.

Files:
- `v1-tx.mjs` — hand-rolled v1 builder + parser. Wire layout pinned from
  solana-message 4.6.0 `versions/v1/message.rs`: instruction HEADERS are one
  contiguous block (nIx x [progIdx u8, nAcc u8, dataLen u16le]) followed by
  the per-ix payloads (account indices then data) — interleaved encoding is
  byte-identical for 1 ix and wrong for 2+. Signing payload is the full
  0x81-prefixed message; signatures append after it. Verified byte-identical
  to @solana/kit 8.2's encoder (kit's `createTransactionMessage({version:1})`
  + `signTransactionMessageWithSigners` also work; web3.js 1.x cannot build v1).
- `run-v1-smoke.mjs` — 2 packed SystemProgram transfers in one v1 tx; run
  before a bench to prove the chain accepts the bytes.
- `run-batch-v1.mjs` — 210-employee bench packing PER_TX (default 3)
  independent batch3 transacts per v1 tx. Each transact consumes its own
  deposit note (no change-note chaining), so the 3 proofs of a tx build in
  parallel and payouts need no healLeafStart.
- `proxy.mjs` — v1 branch in parseTx + multi-transact mirror tracking
  (all commitments/nullifiers of all ixs in a tx).
- `workers/src/solana/wire.rs` — matching v1 parser in the backend
  (`parse_tx` dispatches on the leading 0x81 byte).

The root-history wall: the program keeps the last 100 roots. Every v1 tx
appends 9 leaves, so 16 unbounded lanes burst 144 leaves and proofs fetched
before a burst rotate out of history before exec -> UnknownRoot (custom
error 5) at the ~5.9k-CU merkle check, ix1 failing while ix0 passed.
`run-batch-v1.mjs` layers two defenses:
1. `PIPELINE_SLOTS` (8) caps groups inside the fetch->prove->submit
   lifecycle. Only slot-holders land txs, so by Little's law the leaves
   that land during any proof's window are ~9 x 8 = 72 < 100.
2. A tripwire on the TRUE chain age: `chainNextIndex()` reads nextIndex
   (u32le @ 8) straight from the tree PDA via getAccountInfo; proofs older
   than `GATE_AGE` (90) are rebuilt fresh. Replica-based estimates were
   tried and rejected — the mirror lags the chain (understates) and
   pending-counting double-counts landed txs (overstates ~50 leaves),
   which caused constant false rebuilds that slowed runs by 30-50%.

## Run v1

```sh
SURFPOOL_BIN=$HOME/.local/share/surfpool150/surfpool \
SURFPOOL_FLAGS="--feature txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4" \
  zsh reset-env.sh                       # zsh only (${=SURFPOOL_FLAGS})
bun run-v1-smoke.mjs
export PROGRAM_ID=721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr
bun proxy.mjs &                          # if reset-env did not leave one up
ARK_THREADS=2 bun run-batch-v1.mjs 16 210   # pools, employees (PER_TX env, default 3)
```

## Measured v1 (2026-09-08, same machine, 4 provers, 16 pools x 210 employees)

| config | pay wall | payout txs |
|---|---|---|
| v0 batch3, 1 transact/tx (105 txs) | 30.9 s | 105 |
| v1 batch3, 3 transacts/tx, ARK_THREADS=1 | 21.2 s | 48 |
| v1 batch3, ARK_THREADS=2 | **17.7 s** | 48 |

17.7s detail: 0 lane failures, 0 proof rebuilds (gate never fired),
210/210 paid, max tx 3,206 B (limit 4,096), replica == chain at 560
leaves, proxy 160/160 processed. 112 batch3 proofs x ~0.5s / 4 provers =
~14s = the wall is prover-throughput-bound; packing + v1 removed the
tx-rate bottleneck (3x fewer txs, ~3x less fee/relayer load). More or
faster provers would cut the wall roughly linearly; 4 x 1-thread is this
laptop's memory-safe ceiling, ARK_THREADS=2 uses the remaining cores.
Next real step below ~15s is a wider batch circuit (4 employees/proof
halves the proof count), not tx-layer work.

