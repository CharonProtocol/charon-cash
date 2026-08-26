# rust-prover-bench

Pure-Rust Groth16 prover benchmark against the payroll circuit (`transaction2`).
Compares snarkjs (JS), rapidsnark (C++), and arkworks (Rust) on the **same
witness file**, against the **same ceremony zkey**.

## Run

```sh
# 1) regenerate the fixed witness + input dump (bun resolves the SDK's ESM)
cd fixtures && bun gen-witness.mjs && cd ..

# 2) build + run (argument = prove iterations, default 3)
cargo run --release 5

# variants
RAYON_NUM_THREADS=1 ./target/release/rust-prover-bench 3   # single-threaded prove

# reference provers on the same witness
../../programs/privacy-cash/artifacts/circuits  # zkey/wasm/r1cs live here
/tmp/rapidsnark-src/build_osx/src/prover <zkey> fixtures/witness.wtns p.json pub.json
node ../node_modules/snarkjs/build/cli.cjs g16p <zkey> fixtures/witness.wtns p.json pub.json
```

## Results (2026-08-26, M-series laptop, warm cache)

Circuit: 33,798 constraints, 33,862 witness values, 7 public signals.

| prover | prove wall | CPU per proof | per-proof overhead | peak RSS |
|---|---|---|---|---|
| snarkjs `g16p` (node) | 4.0s | ~13s | in-process | 502MB |
| rapidsnark (C++ binary) | 0.45–0.47s | ~0.5s | process spawn + 16MB zkey read | 43MB |
| **arkworks (Rust), rayon** | **0.27–0.31s** | ~2s | none — pk loaded once (2.2s startup) | 200MB |
| arkworks (Rust), 1 thread | 1.04s | ~1.0s | none | 200MB |

All three provers produce byte-identical public signals (same values, same
order), and the arkworks proof passes Groth16 verification against the
ceremony zkey's verifying key. The full Rust pipeline — wasmer witness from
`input.json` + prove — also verifies: no snarkjs, no C++, no node.

## What this means for the engine

- One Rust process can hold the proving key and prove ~0.3s/proof with rayon,
  or ~1.0s/proof pinned to one thread — with zero per-proof process spawn
  (rapidsnark pays spawn + zkey load on every proof, which is most of the
  ~1.0s/proof seen in the 16-lane engine runs).
- Aggregate CPU per proof: ~1.0s single-threaded (single-thread is 2× more
  CPU-efficient than rayon-per-proof; pin `RAYON_NUM_THREADS=1` when many
  proves run concurrently and let the lanes provide the parallelism).
- The engine could become a single Rust binary (witness + prove + submit)
  with the SDK keeping JS proving for browser users.

## Implementation notes

- `read_zkey` (ark-circom) parses the snarkjs zkey into an arkworks
  `ProvingKey`; proving must use `Groth16::<Bn254, CircomReduction>` — the
  snarkjs-compatible witness map (default `LibsnarkReduction` would produce
  proofs the zkey's vk does not verify).
- The `.wtns` witness values are plain little-endian field elements in wire
  order; `CircomCircuit` must be built with `wire_mapping = None` (wasm
  witness order == r1cs wire order, same as `CircomBuilder::build()` does).
- `input.json` quirks mirrored in `flatten`: BN.js values serialize as hex
  strings (`parse radix 10 → fallback 16`), and Buffers serialize as
  `{type: "Buffer", data: [...]}` → little-endian bytes → field element
  (same interpretation ffjavascript's `stringifyBigInts` uses).
- The crate is standalone (`[workspace]` table) so the root workspace does
  not pick it up; `target/` is git-ignored.

## prover-server (persistent proving service)

`src/bin/prover-server.rs` loads the zkey + witness wasm once, then proves
one circuit input per stdin JSON line, replying in snarkjs proof format:

```
{"id":1,"input":{...}}  ->  {"id":1,"ok":true,"proof":{pi_a,pi_b,pi_c},"publicSignals":[...]}
```

Env: `ARK_THREADS` (rayon threads per server, default 1), `ARK_G2`
(`c0c1` = snarkjs Fp2 order, verified against the ceremony vk), and
`ARK_BAD_INPUTS` (append the request JSON when self-verify fails — inputs
whose witness does not satisfy the constraints, e.g. a merkle path walked
at the wrong leaf index).

Every proof is self-verified against the vk before being returned, so bad
inputs surface as client-side errors instead of on-chain InvalidProof.

In-run measured (see `bench/`): 4 servers x 1 thread on an M1 Air take a
16-pool x 210-employee payroll to **81.3s** pay wall (226 proofs, p50
1.42s, 98% prove-bound) vs 126.4s with rapidsnark spawn-per-proof.
