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
| + ARK_THREADS=2 (both cores to each prover) | 67.6 s | 1,107 ms |
| + v1 txs, 3 transacts/tx + memo pad (`run-standard-v1.mjs`) | **63.3 s** | — |

Every run: 210/210 paid, 0 lane failures, on-chain tree == local replica,
final root in the 100-root history. The packed run's largest tx: 2,961 of
4,096 bytes.

| | Standard circuit (this branch, fully tuned) | Batch5 circuits (`payroll` branch) |
|---|---|---|
| Pay wall, 210 salaries | **63.3 s** | **11.32 s** |
| Payout txs | 80 (3 salaries/tx) | 32 (8 salaries/tx) |
| Salaries per proof | 1 | 4 |
| Proofs required | 210 (+210 deposits) | 53 (+16 deposits) |
| Verifying keys | 1 (the protocol's own) | +2 (ceremony per batch circuit) |

The custom circuits buy ~5.6x end-to-end — but they are an *optimization*,
not a prerequisite. Payroll works, private and gasless, on the untouched
protocol today.

### The experiment proves where the speed lives

`run-standard-v1.mjs` runs the batch5 pipeline's own machinery against the
stock circuit: v1 wire packing, the memo-pad CU trick, root-history gates,
the arkworks pool, 2 threads per prover. Packing 226 → 80 txs moved the wall
only 67.6 → 63.3 s (~6%), exactly as the prove-bound model predicted: the
wall is `210 proofs × per-proof time ÷ provers`, and the standard circuit
fixes both terms at 1 salary per proof. Batch5's 11.3 s comes from proving
4 salaries per proof — 53 proofs instead of 210, and deposits scale down
210 → 16 with it. That is where the ~5.6x lives: in the circuit, nowhere
else. The remaining non-circuit lever (a Rust witness generator replacing
the JavaScript witness step) is noted for the future.

### Measurement hygiene

The first run of the day read 114 s — because the demo stack (vite dev server,
wrangler workerd, browser) was eating the same 8 cores. Proving is CPU-bound,
so contention shows up 1:1 in the wall. All numbers above are quiet-machine
runs; prove p50 1.35 s → 1.10 s across the quiet runs.

## Run it

```bash
# v0 pipeline (1 salary/tx): 67.6s wall
SURFPOOL_BIN=$HOME/.local/share/surfpool150/surfpool \
SURFPOOL_FLAGS="--feature txv1hPU76QFBVeq3942jJ65e9Em2xbdbCJrzX8sM4U4" \
  zsh payroll/rust-prover-bench/bench/reset-env.sh    # fresh chain + relayer
cd payroll/rust-prover-bench/bench
export PROGRAM_ID=<your local deploy> ARK_THREADS=2
bun run.mjs 16 210                                    # v0, 226 txs
bun run-standard-v1.mjs 16 210                        # v1-packed, 80 txs — 63.3s
```

Raw runs: /tmp/pfast/run-*.json, /tmp/pfast-std-v1/run-*.json (`payWallMs`,
`chainVerify`).

## The one fix this branch carries

`sdk/src/program.ts` — the standard transact's v0 transaction measured 1,233
bytes, exactly one byte over the legacy 1,232 cap (nobody noticed while the
fast path rode v1 txs). The fallback chain now ends at `[transactIx]` alone:
chains that budget a tx by summed per-instruction defaults give a lone
instruction 200k CU, and the standard transact needs ~158k.
