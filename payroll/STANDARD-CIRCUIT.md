# Payroll on the standard protocol path (no custom circuits)

This branch exists to answer one question: **what does a 210-salary payroll cost
if it uses only the general privacy-cash protocol — the stock `transact`
instruction and the standard `transaction2` circuit — with no batch3/batch5
circuits at all?**

Why it matters: this is what payroll looks like as a pure *implementation* of
the protocol. Any app (payroll, private airdrops, private payments) can do
exactly this with the shipped SDK — no ceremony, no custom circuits, no special
instructions.

## The measured answer (2026-09-14, same 8-core / 8 GB laptop)

| | Standard circuit (this branch) | Batch5 circuits (`payroll` branch) |
|---|---|---|
| Pay wall, 210 salaries | **114.15 s** | **11.32 s** |
| Employees paid | 210/210, 0 failures | 210/210, 0 failures |
| Payout txs | 226 (1 salary/tx) | 32 (8 salaries/tx) |
| Salaries per proof | 1 | 4 |
| Proof time p50 | 1,884 ms | 679 ms |
| Verifying keys | 1 (the protocol's own) | +2 (ceremony per batch circuit) |

Chain verified after the run: on-chain tree == local replica (452 leaves),
final root in the 100-root history.

So the custom circuits buy ~10x end-to-end — but they are an *optimization*,
not a prerequisite. Payroll works, private and gasless, on the untouched
protocol today.

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
