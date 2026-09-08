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

## One command (fresh machine)

```sh
zsh payroll/rust-prover-bench/bench/run-210.sh
```

Installs whatever is missing (bun, Solana CLI incl. cargo-build-sbf, rust
stable, surfpool >= 1.5.0 with the txv1 feature), generates keypairs and
`workers/.dev.vars` on first run, builds the program and prover-server,
resets the env, then runs `BATCH5=1 bun run-batch-v1.mjs 16 210`. The prover
pool auto-sizes from RAM and cores (`min(16, (GB-3)/1.25, cores*0.75)`), so
wall time adapts to the machine: 8GB / 8-core = 4 provers = 12.7s measured;
a 32GB / 12-core box gets 9 provers. The batch5 zkey is committed at
`programs/privacy-cash/artifacts/circuits/transaction_batch5.zkey`.

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
| v1 batch3, ARK_THREADS=2 | 17.7 s (re-run 18.3 s) | 48 |
| v1 batch5, 2 transacts + memo pad/tx (8 salaries/tx), ARK_THREADS=2 | **12.7 s** | 32 |

12.7s detail: 210/210 paid, 0 lane failures, 0 proof rebuilds, max tx
2,919 B, replica == chain at 448 leaves, root in history. Fee:
50,000 lamports per 8-salary tx = **6,250 per employee** (half of
batch3's 12,500). The pay wall is still prover-throughput-bound (64
batch5 proofs x ~0.9s contended / 4 provers ~ 12s), so the gain over
batch3 is 1.4x, not the naive 2x — the chain-side win is 8 salaries/tx
(fewer txs, half the fee) at no loss of throughput.

17.7s detail: 0 lane failures, 0 proof rebuilds (gate never fired),
210/210 paid, max tx 3,206 B (limit 4,096), replica == chain at 560
leaves, proxy 160/160 processed. 112 batch3 proofs x ~0.5s / 4 provers =
~14s = the wall is prover-throughput-bound; packing + v1 removed the
tx-rate bottleneck (3x fewer txs, ~3x less fee/relayer load). More or
faster provers would cut the wall roughly linearly; 4 x 1-thread is this
laptop's memory-safe ceiling, ARK_THREADS=2 uses the remaining cores.

## The CU budget law, and the memo-pad packing that beats it (measured 2026-09-08)

A wider circuit — `transaction_batch5` = Transaction(26,2,5), 4 employees
+ change per proof, 10 public inputs — was wired end-to-end (circom,
zkey, `VERIFYING_KEY_BATCH5`, disc 8, `BATCH5=1` bench mode). It proves
at 679ms p50 (vs batch3's 643ms for half the employees) and the
instruction **executes correctly on-chain** (proof verified, 5 leaves
appended). Its instruction costs more than one default budget, so
landing it needs the packing rule below.

**The law.** The v1 runtime (surfpool 1.5.0 / agave 4.1.2, feature on)
ignores the tx's requested `cuLimit` config. Instead it budgets every
instruction at its *default* cost and sums them:

- unknown BPF program ix → 200,000 default
- SystemProgram transfer → 3,000 default
- the sum is a **tx-level pool consumed sequentially** — there is no
  per-instruction sub-cap

Measured probes: `[batch5]` → "consumed X of 200000" (died, needs
241k); `[batch5, transfer]` → of **203,000** (died);
`[batch5, batch5, transfer]` with cuLimit 600k configured → of
**403,000** = 200k+200k+3k, ix0 succeeded at 239,715 CU and ix1 starved
with 163,285 left. batch3 never needed any of this: 3 transacts sum to
600k of budget for 3×186k = 558k of use.

**The pad.** The trick is an ix whose *default* is 200k but whose real
cost is tiny: a no-accounts **SPL Memo** call (~free). `[batch5,
batch5, memo]` budgets 600k for ~480k actually used, in a 2,896-byte
tx: **8 salaries per tx**. Memo is a normal mainnet program, so this
packs on any chain running the same runtime — but a chain that honors
the `cuLimit` config would need no pad at all (ask for 600k directly).

**append_pair (2026-09-09).** The merkle append itself had the same
shape of waste: two consecutive appends each walk all 26 tree levels,
and the second walk overwrites every level the first wrote. A
parity-aware `append_many` pairs a leaf landing on an even index with
its neighbour under one level-0 hash — 26 hashes per pair instead of
52 — and is correct for any starting parity (deposits interleave
single leaves). Only the final root enters root_history; intermediate
roots of a multi-leaf transact are unobservable, and one root per
transact instead of per leaf slows eviction of the 100-root window by
the batch size. Unit tests assert byte-equality against the shipped
single-leaf append across starting parities 0–3 and sizes 1–6; the
68-test real-proof suite passes unchanged. Measured on-chain: batch5
transact **239,715 → 195,497 CU** (n=18, range 194.0k–196.5k, −18.4%)
— every batch5 instruction now fits one 200k default. Pay wall is
unchanged at ~12-14s: proving, not chain execution, is the
bottleneck.

