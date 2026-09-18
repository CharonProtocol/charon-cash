# Poseidon2 experiment (2026-09-18)

**Result: not a drop-in replacement.** `experimental-poseidon2` integrates Blueshift
Horizen width-3 compression into both SOL/SPL initializers and transaction tree
updates. It is disabled by default and must not be deployed with the committed
circuits, keys, or existing tree accounts. The experimental real-proof transaction
benchmark fails with `InvalidArgument` on the current runtime. No successful
Poseidon2 transaction CU/time measurement is available.

## Measured comparison

| Scenario | Poseidon syscall CU | Median host execution (ms) | p95 (ms) | Poseidon2 CU / time |
|---|---:|---:|---:|---|
| SOL first deposit | 137,082 | 4.976 | 5.107 | N/A: transaction fails |
| SOL partial withdrawal | 138,443 | 5.096 | 5.388 | N/A: benchmark stops at deposit failure |
| SPL deposit, ATA exists | 143,788 | 5.052 | 5.244 | N/A: benchmark stops at deposit failure |
| SPL deposit, ATA missing | 154,080 | 4.990 | 5.186 | N/A: benchmark stops at deposit failure |

Thirty samples per scenario, following one validated warmup, on Intel i7-12650H,
x86_64 Linux; Rust 1.89.0, cargo-build-sbf 3.1.8, platform-tools v1.52,
Mollusk 0.14.0. Timer surrounds `process_instruction`, including its host harness
work, but excludes proof generation, program loading and result assertions.
This is local host latency, **not validator-only execution or network confirmation
time**. Mollusk's `execution_time` field returned zero, so it is not used.
Snapshots are replayed unchanged and every sample checks success, resulting
accounts and identical CU consumption. Random keys/proofs/PDA bump searches mean
CU totals can vary between independent runs; samples within a run share inputs.
The final timing run was made after other compilation/test work completed.

Raw outputs: [Poseidon](poseidon.log), [Poseidon2 failure](poseidon2-runtime.log).
`TIMING` columns are scenario, CU, samples, median ns (upper middle), p95 ns, min ns.
Original baseline revision: `5a60b70fed18250bdf482dc93692333646d03044`.

## Why the swap cannot preserve behavior

1. The circuit's `circuits/merkleProof.circom` computes `Poseidon(2)`; Horizen
   Poseidon2 computes different roots. Native assertions demonstrate this,
   including the empty root at height 26. A new circuit, witness/proving artifacts,
   verifying key and setup are necessary for spend proofs. Existing tree state
   cannot simply be reinterpreted. This experiment does not alter setup artifacts.
2. [Pinned Blueshift source](https://github.com/blueshift-gg/solana-poseidon2/tree/fd0677b2a518434cf190ace74f01b85878f6b848)
   requires the SIMD-0529 `sol_big_mod_exp` runtime implementation, documented as
   Agave 4.3 (4.2 has a stub). This repository pins Agave 3.1.8. The SBF build
   succeeds, and the artifact loads, but transaction execution fails. The precise
   failure location is not instrumented; do not treat its failed execution as a
   full-transaction benchmark. The benchmark intentionally retains original
   Poseidon proof/account fixtures to test replacement compatibility.
3. Upstream reports approximately 104,000 CU for **one** Horizen compression
   on SBPF v3. Our pair append needs 26 compressions. That implies roughly
   **2,704,000 CU for hashing alone**, before verification/transfers, exceeding
   the 1.4M transaction budget. This is an extrapolation from upstream numbers,
   **not a measured Privacy Cash Poseidon2 transaction**.

Blueshift still uses a syscall for its S-box; this is not a syscall-free backend.
Native tree-equivalence tests run with either hasher. Empty roots are generated
once by the host build script using the pinned implementation, rather than
recomputed on-chain. The default deployed backend remains Poseidon.

## Reproduce

```sh
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml --tools-version v1.52 -- --locked
BENCH_SAMPLES=30 cargo test --locked --package privacy-cash --test bench -- --nocapture
cargo test --locked --package privacy-cash --lib --features experimental-poseidon2
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml --tools-version v1.52 --sbf-out-dir target/poseidon2 -- --locked --features experimental-poseidon2
# Expected to fail; do not substitute this artifact for target/deploy/privacy_cash.so.
BENCH_PROGRAM="$PWD/target/poseidon2/privacy_cash" cargo test --locked --package privacy-cash --test bench -- --nocapture
```

## Validation

Local: 70 default program tests, 18 experimental native tests, 27 model/property
tests and 10 CI helper tests passed. Clippy correctness, doctests, spec warning
baseline, model/proof reconciliation, circuit recompilation and key integrity
also passed. Both SBF variants compile. The experimental transaction benchmark
fails; successful Poseidon2 end-to-end behavior is **not** established.

CI additionally runs experimental native assertions; its delivered SBF artifact
remains the default Poseidon build. A green default CI gate does not certify the
experimental backend for deployment.
