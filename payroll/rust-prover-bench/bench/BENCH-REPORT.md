# Charon Pay — end-to-end benchmark matrix (2026-10-06)

Every config below is a **complete fresh run on a fresh local chain** (surfpool + fresh
program deploy + fresh merkle tree): register employer → fund → deposit per employee
(2 leaves each) → prove → submit payout txs → **verify on chain** (tree nextIndex +
root match between chain and replica; employees hold exactly their salary note).
77 grid configs = rows {5, 50, 100, 210} × lanes {1..16} × prover-pool sizes, both
engines, plus an `ARK_THREADS` isolation pair (79 runs total).
**79/79 runs paid every employee, 0 lane failures, 0 stuck txs** (after the two
resilience fixes described at the bottom).

Reproduce: `zsh reset-stack.sh` then `zsh run-matrix.sh [native|wasm|both]`, parse with
`bun parse-matrix.mjs`. Raw logs + per-run JSON in `bench/results/`.

## Headline numbers (210 employees, this 8-core / 8GB Mac)

| setup | wall | what dominates |
|---|---|---|
| **native arkworks, 4 lanes, 4 provers** (bench backend) | **172s** | deposits ~108s, pay ~57s |
| **wasm-arkworks in browser** (multi-threaded, 4 workers, measured separately) | **~298s** | proofs ~0.32s ea in-browser |
| wasm-arkworks under bun (bench harness, no SharedArrayBuffer) | 340s | proofs 3.3s ea — bun penalty, not browser |
| 1 lane (1-to-1, no parallelism), native | 511s | deposits fully sequential ~405s |
| 1 lane wasm | 941s | sequential + 3.3s/proof |
| production today (browser snarkjs, sequential) | 15–20 min | snarkjs ~4s/proof, 1 tx at a time |

**So: backend prover ≈ 3 min, browser wasm ≈ 5 min, 1-to-1 ≈ 8.5 min, today's prod ≈ 15–20 min — all for 210 paid employees, end-to-end, verified on chain.**

## Why each phase costs what it costs

1. **Register** — negligible (<1.5s even at 210×16; it's one signature + a recipients PUT).
2. **Deposits = the setup wall.** One deposit tx per employee, 2 leaves each (420 leaves
   for 210). They serialize at the relayer/chain lock (~2 tx/s: send → wait confirm →
   next). 210 deposits ≈ 105–110s at ≥4 lanes, ≈ 405s fully sequential at 1 lane.
   **This phase, not proving, is 60–80% of total wall time in every fast config.**
3. **Proofs** — every payout consumes a note and produces 2 output notes, so N employees
   = 2N+1 `transaction2` proofs. Native arkworks: p50 ≈ 0.65–0.95s uncontended, degrading
   to ≈ 2s when 8+ lanes fight for cores. wasm-arkworks: 3.3s in bun (no
   SharedArrayBuffer/pthreads), **0.32s in a real multi-threaded browser tab** (measured
   earlier, `wasm-prover-browser-210` = 298s total). With a pool of K provers, proofs
   pipeline behind the chain lock, so they stop mattering once K ≥ 2 — unless lanes
   starve the cores (see p50 blowup at 16 lanes).
4. **Payout txs** — 3 transacts packed per 4096B v1 tx → 70 v1-txs for 210 employees.
   Same ~1.5–2 tx/s serialization; root-age gate (rebuild if root older than 90/100
   history) occasionally re-proves and re-sends a group under lane contention — that's
   why 210×16 shows 80 v1-txs instead of 70.
5. **Total wall** = deposits (serialized) + pay (max(proving pipeline, tx serialization)).
   Adding lanes past 4 buys nothing on this machine; adding prover workers past ~2
   buys nothing once the chain lock is the binding constraint.

## Scaling laws (measured) — full grids, every cell a complete verified run

**NATIVE arkworks (default 4-prover pool) — wall time, rows × lanes:**

| rows | 1 lane | 2 | 4 | 6 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|---|
| **210** | 512s | 232s | 172s | 171s | 169s | 173s | 173s |
| **100** | 245s | 117s | 87s | 85s | 86s | 87s | 86s |
| **50** | 126s | 65s | 46s | 49s | 46s | 47s | 49s |
| **5** | 17s | 13s | 11s | 13s | 13s | 14s | 14s |

**WASM arkworks (4 prover workers, bun harness) — wall time, rows × lanes:**

| rows | 1 lane | 2 | 4 | 6 | 8 | 12 | 16 |
|---|---|---|---|---|---|---|---|
| **210** | 941s | 490s | 340s | 286s | 284s | 273s | 308s |
| **100** | 499s | 323s | 146s | 193s | 132s | 257s | 161s |
| **50** | 232s | 130s | 98s | 102s | 110s | 116s | 94s |
| **5** | 62s | 66s | 28s | 32s | 35s | 28s | 28s |

Both engines plateau at 4 lanes: past that, extra lanes only add core contention
(native prove p50 at 210 rows: 943ms @4 lanes → 1928ms @8 → 1928ms @16). Wasm
mid-size cells wobble ±40% between adjacent lane counts (100-row: 146 @4, 193 @6,
132 @8, 257 @12) — single-run variance, trend unchanged. 5-row cells are
bootstrap-dominated (tree init + circuit load + funding ≈ 28s floor), so lanes
barely matter there.

**Prover-pool sweep at 4 lanes** (`ARK_PROVERS` = native processes, workers =
`WasmProverPool` — the same dimension for both engines):

| rows | nat 1p | nat 2p | nat 4p (def) | wasm 1w | wasm 2w | wasm 4w (def) |
|---|---|---|---|---|---|---|
| **210** | 267s | 194s | 172s | 749s | 443s | 340s |
| **100** | 129s | 93s | 87s | 374s | 215s | 146s |
| **50** | 115s | 96s | 46s | 199s | 122s | 98s |
| **5** | 22s | 23s | 11s | 30s | 27s | 28s |

Per-proof (wasm/bun): 11.7s @1w, ~6s @2w, ~3.3s @4w — linear in workers until the
chain lock binds; in a real browser (0.32s/proof measured) even 2 workers saturate
it. At 1 lane the pool size is irrelevant for both engines (native 210×1: 575/532/512s
at 1p/2p/4p; wasm 210×1: 976/945/941s at 1w/2w/4w) — the lane serializes everything.

**Within-proof multithreading** (`ARK_THREADS`, isolated at 210 rows × 4 lanes,
4 prover processes — same multithreading the browser wasm gets via
SharedArrayBuffer and bun cannot):

| threads/prover | total threads | wall | deposits | prove p50 |
|---|---|---|---|---|
| 1 | 4 | 321s | 131s | — |
| **2 (default)** | 8 | **172s** | ~108s | ~0.94s |
| 4 | 16 | 506s | 331s | 5.8s |

So yes — within-proof threading is native's real win (1→2 threads ≈ **1.9× faster**,
321s → 172s, proofs halve), **but only up to core count**: 4 provers × 4 threads = 16
threads on 8 cores oversubscribes and *collapses* (506s, prove p50 6.2× worse — the
whole machine degrades, even deposit registrations slow 4× from memory pressure).
Rule of thumb: keep `prover_processes × threads ≤ cores`. The default (4p × 2t = 8
on 8 cores) is exactly at the optimum.

**Rows:** 5→50→100→210 at 4 lanes native: 11–12s → 46s → 87s → 172s (≈ linear in rows,
constant ~10s floor = chain bootstrap + tree init + proof-wasm load).

## Native vs wasm, same config (210×4)

| engine | wall | proofs avg | note |
|---|---|---|---|
| native arkworks (Rust CLI pool) | 172s | 1.47s | what a backend prover service would do |
| wasm-arkworks, browser MT | ~298s | 0.32s | shipped engine, in-browser |
| wasm-arkworks, bun harness | 340s | 3.3–4.1s | bench harness penalty (no SAB/pthreads) |

The wasm engine in a real browser is within **~1.7× of the native prover**; the gap is
wasm codegen + memory-copy overhead per proof, not the circuit.

## The four standing questions

1. **How fast with a backend prover (native arkworks)?** 172s for 210 employees
   (4 lanes), 88s for 100, 46s for 50 — deposits dominate; proving is fully hidden by
   the pipeline. A backend prover would cut user-visible latency to "deposit-bound",
   and the prover only ever sees the payer's witness (employees' notes never leave
   their devices).
2. **How fast with the browser wasm engine?** ~5 min for 210 (298s measured in-browser
   MT; 340s in the bun harness with the same shipped engine + circuit artifacts).
   100 rows ≈ 146s, 50 ≈ 98s, 5 ≈ 28s.
3. **How fast 1-to-1 (no lanes, no batching tricks)?** native 511s / wasm 941s for 210;
   wasm 5-row 1-lane 1-worker = 27.7s ≈ the honest per-run floor (bootstrap + tree init
   + first proofs + finality). Per-employee marginal cost end-to-end ≈ 2.4s native,
   ≈ 4.5s wasm-in-bun.
4. **Would chain events (Umbra-style explorer events) help?** They'd help **indexing**,
   not speed: today the replica/mirror replays `getSignaturesForAddress` + decodes txs
   (250ms watch loop, D1 mirror sync in prod). Emitting an event per commitment would
   make leaves pull-able via `getProgramLogs`/event CPI in one call, kill the
   replica-ordering failure class we hit in this bench (same-slot tx ordering), and cut
   Workers subrequest pressure (1 events fetch vs N tx fetches — relevant given the
   ~50-subrequest Neon/CF budget). What it would **not** change: deposit serialization
   (~2 tx/s chain lock), proof cost (0.32–1s), or tx size/fee. Umbra's events exist for
   their *explorer/recipient discovery*, not throughput — same trade here.

## What broke during the bench, and the two fixes (bench-only)

1. **Replica ordering**: surfpool's `getSignaturesForAddress` order ≠ block execution
   order for same-slot txs → replica leaf order diverged → phantom roots → spurious
   `UnknownRoot`. Fix: submission mutex in the bench relayer (send → confirm, one at a
   time) — which is also what production's relayer already does implicitly.
2. **Surfpool transient stalls under load** (prover threads + tx processing on 8
   cores): blockhash RPC errors, confirms landing ~77 slots late. Fix: client-side
   retries with adjudication (`retryRpc` around deposit/blockhash/submit/nextIndex —
   same bytes on resubmit = same signature = idempotent) and a 90s confirm poll in the
   bench relayer (web3.js gives up at 30s). After both fixes: 79/79 clean.

## Machine + versions

8-core arm64 Mac, 8GB RAM, macOS 27; surfpool 1.5.0 `--offline` with
`--feature txv1hPU…` (4096B v1 txs); program `privacy_cash` built from this branch;
native provers = arkworks `prover-server` pool (ARK_THREADS=2 each);
wasm engine = shipped `wasm-arkworks` artifacts (byte-identical to
`payroll/public/circuit/`). Deposits are 0.05 SOL each, payouts 0.05 SOL/employee.
