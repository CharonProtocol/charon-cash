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

81.3s detail: 226 proofs (210 pays + 16 deposits), p50 1.42s, prove CPU
318.7s / 4 provers = 79.7s floor (98% prove-bound), 0 lane failures,
replica root == chain root. 6 provers swap-thrash this machine (one proof
stretched to 902s) — 4 is the ceiling here.
