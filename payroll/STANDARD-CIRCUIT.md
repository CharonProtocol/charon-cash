# Payroll on the standard protocol path (no custom circuits)

This branch exists to answer one question: **what does a 210-salary payroll cost
if it uses only the general privacy-cash protocol — the stock `transact`
instruction and the standard `transaction2` circuit — with no batch3/batch5
circuits at all?**

Why it matters: this is what payroll looks like as a pure *implementation* of
the protocol. Any app (payroll, private airdrops, private payments) can do
exactly this with the shipped SDK — no ceremony, no custom circuits, no special
instructions.

## The measured answer (2026-09-14/15, same 8-core / 8 GB laptop)

How far the standard circuit goes with every non-circuit optimization applied
(same program: parallel lanes, append_many, root-window guards; prover pool
tuned the way the batch runs were):

| Standard-circuit configuration | Pay wall (210 salaries) | Prove p50 |
|---|---|---|
| v0 txs, 4 provers × 1 thread, machine loaded with the demo stack | 114.15 s | 1,884 ms |
| same, quiet machine | 81.0 s *(historical 81.3 s reproduced)* | 1,346 ms |
| + ARK_THREADS=2 (both cores to each prover) | **67.6 s** | 1,107 ms |

Every run: 210/210 paid, 0 lane failures, on-chain tree == local replica
(452 leaves), final root in the 100-root history.

| | Standard circuit (this branch, tuned) | Batch5 circuits (`payroll` branch) |
|---|---|---|
| Pay wall, 210 salaries | **67.6 s** | **11.32 s** |
| Payout txs | 226 (1 salary/tx) | 32 (8 salaries/tx) |
| Salaries per proof | 1 | 4 |
| Proof time p50 | 1,107 ms | 679 ms |
| Verifying keys | 1 (the protocol's own) | +2 (ceremony per batch circuit) |

The custom circuits buy ~6x end-to-end — but they are an *optimization*,
not a prerequisite. Payroll works, private and gasless, on the untouched
protocol today.

### Why tx-packing can't push the standard circuit much further

The wall is **proving**, not transactions: proveTotal ≈ 250 s across 4 provers
≈ the 67.6 s wall itself. The standard circuit proves 1 salary per proof, so
210 salaries need 210 proofs no matter how transactions are packed. v1 txs
could hold 2 standard transacts (bytes cap it there), which halves fees and tx
count but leaves the proving wall untouched. Batch5 gets its 11.3 s because
the *circuit* proves 4 salaries per proof — 53 proofs instead of 210. That is
precisely the 6x: it lives in the circuit, nowhere else.

The remaining non-circuit lever (a Rust witness generator — the current
witness step is JavaScript) is noted for the future; it would attack the same
1.1 s per-proof cost without touching the circuit or its verifying key.

### Measurement hygiene

The first run of the day read 114 s — because the demo stack (vite dev server,
wrangler workerd, browser) was eating the same 8 cores. Proving is CPU-bound,
so contention shows up 1:1 in the wall. All numbers above are quiet-machine
runs; prove p50 1.35 s → 1.10 s across the quiet runs.

## Run it

```bash
zsh payroll/rust-prover-bench/bench/reset-env.sh    # fresh chain + relayer
cd payroll/rust-prover-bench/bench
export PROGRAM_ID=<your local deploy>
bun run.mjs 16 210                                  # standard circuit, 16 pools, 210 employees
```

Raw run: /tmp/pfast/run-*.json (`payWallMs`, `chainVerify`).

## The one fix this branch carries

`sdk/src/program.ts` — the standard transact's v0 transaction measured 1,233
bytes, exactly one byte over the legacy 1,232 cap (nobody noticed while the
fast path rode v1 txs). The fallback chain now ends at `[transactIx]` alone:
chains that budget a tx by summed per-instruction defaults give a lone
instruction 200k CU, and the standard transact needs ~158k.
