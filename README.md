# Privacy Cash

A confidential pool for SOL and SPL tokens on Solana, written with [pinocchio](https://github.com/anza-xyz/pinocchio) (zero-dependency, no Anchor).

Deposits, withdrawals, and shielded transfers are authorized by **Groth16 zk-SNARK proofs** over BN254, verified on-chain through the `sol_alt_bn128` syscalls against a fixed-depth **Poseidon Merkle tree** of commitments.

---

## What it does

Funds in the pool are represented as *commitments* — Poseidon hashes of (amount, owner key, blinding) — stored as leaves in an on-chain Merkle tree. Spending a commitment never reveals which leaf was spent:

1. **Deposit** — you transfer SOL/SPL into the pool vault and the program appends two new output commitments to the tree. The link between depositor and note is still public at this step; anonymity comes from later spends.
2. **Shielded transfer** — you prove in zero knowledge that you own two existing leaves under a recent Merkle root, publish their **nullifiers**, and append two new output commitments. No amounts, owners, or spent leaves are revealed. Net movement of funds is zero.
3. **Withdrawal** — same proof, but with a negative net amount, so the vault pays out to a recipient address you name.

Four mechanisms make this safe:

- **Nullifiers.** Each spend derives a nullifier per input note. The program creates a PDA at `["nullifier0", hash]` / `["nullifier1", hash]` via the System Program. Reusing a note fails, because the account already exists — double-spend protection with no on-chain set to maintain.
- **Root history.** The tree keeps the last **100** roots in a ring buffer, so a proof built a few slots ago stays valid despite concurrent inserts.
- **ext_data_hash binding.** The program recomputes `keccak256(recipient, ext_amount, encrypted_output1, encrypted_output2, fee, fee_recipient, mint)` and requires it to equal the value committed inside the proof. A proof therefore cannot be replayed with a different recipient, fee, or fee recipient — it is front-run proof.
- **Public amount check.** `public_amount` from the proof must be consistent with `ext_amount` and `fee` in field arithmetic, and the fee must fall inside the configured rate ± error margin.

Only then is the Groth16 proof itself checked against the verifying key baked into `src/groth16.rs`.

---

## Features

**Assets**
- Native SOL pool (one tree, one lamport vault PDA).
- One Merkle tree per SPL mint, each with its own vault ATA owned by the `global_config` PDA.
- Mint allowlist (`ALLOWED_TOKENS` in `src/constants.rs`: USDC, USDT, ORE, ZEC, stORE, jlUSDC, jlWSOL), bypassable with `ALLOW_ALL_SPL_TOKENS`.

**Crypto**
- Groth16 / BN254 verifier, a port of Light Protocol's `groth16-solana`.
- Poseidon incremental Merkle tree, height **26** (~67M leaves), 100-root history.
- 2-in / 2-out transaction circuit (`circuits/transaction2.circom`).

**Protocol**
- Deposit, withdraw, and shielded transfer in a single `Transact` / `TransactSpl` instruction, distinguished by the sign of `ext_amount`.
- Per-tree deposit cap (default `1_000_000_000_000`), tunable per pool.
- Fee rates in basis points, shared across pools: deposit `0`, withdrawal `25` (0.25%), error margin `500` (5%).
- Encrypted output notes carried in instruction data so recipients can scan and decrypt their own notes.
- Optional admin pubkey gate on initialization (`ADMIN_PUBKEY`, currently `None`).

**Engineering**
- Zero-copy account layouts (`#[repr(C)]` + `bytemuck::Pod`) — no Borsh on the account side.
- Integration tests run against `litesvm` with **real proofs** generated at test time via `ark-circom` + `wasmer`, not mocks.
- Compute-unit benchmarks via `mollusk-svm-bencher`.
- Formal spec plus generated verification harnesses (see below).

---

## Instructions

Dispatch is on the first byte of instruction data (`src/lib.rs`, `src/instructions/mod.rs`).

| # | Instruction | Purpose |
|---|---|---|
| 0 | `Initialize` | Create the SOL tree, the SOL vault, and `GlobalConfig`. |
| 1 | `InitializeTreeAccountForSplToken` | Create a Merkle tree for one SPL mint. |
| 2 | `Transact` | Deposit / withdraw / shielded transfer, native SOL. |
| 3 | `TransactSpl` | Same, for one SPL mint. |
| 4 | `UpdateDepositLimit` | Set `max_deposit_amount` on the SOL tree. |
| 5 | `UpdateDepositLimitForSpl` | Set `max_deposit_amount` on one SPL tree. |
| 6 | `UpdateGlobalConfig` | Set fee rates via a bitmask (`0x01` deposit, `0x02` withdrawal, `0x04` error margin). |

### Accounts and PDAs

| Account | Seeds | Contents |
|---|---|---|
| `MerkleTreeAccount` | `["merkle_tree"]`, or `["merkle_tree", mint]` | `authority`, `next_index`, `root_index`, `max_deposit_amount`, `bump`, `roots[100]`, `filled_subtrees[26]` |
| `TreeTokenAccount` | `["tree_token"]` | SOL vault. `authority`, `bump` |
| `GlobalConfig` | `["global_config"]` | `authority`, `deposit_fee_rate`, `withdrawal_fee_rate`, `fee_error_margin`, `bump`. Also the SPL vault ATA authority |
| Nullifier PDAs | `["nullifier0", hash]`, `["nullifier1", hash]` | Empty; existence *is* the spent marker |

`Transact` takes 11 accounts and `TransactSpl` takes 16, so client transactions generally need an address lookup table — see `tests/common/test_alt.rs`.

### Transact execution order

```
1. verify signer + system program
2. create nullifier0 / nullifier1 PDAs      (double-spend guard)
3. proof.root is in tree.roots              (root history)
4. recompute ext_data_hash, compare to proof
5. check_public_amount(ext_amount, fee) + validate_fee()
6. Groth16 verify against VERIFYING_KEY
7. move funds  (ext_amount > 0 deposit, < 0 withdraw + pay fee)
8. append both output commitments to the tree
```

---

## Usage

### Build

```bash
cargo build            # native, for tests
cargo build-sbf        # on-chain BPF/SBF artifact — required before any test that loads the .so
```

### Test

```bash
cargo test                        # everything
cargo test --test sol_tests       # native SOL pool
cargo test --test spl_tests       # SPL pool
cargo test --test spl_mint_tests  # per-mint tree setup
cargo test --test bench           # compute-unit benchmarks
```

Tests generate real Groth16 proofs, so the first run is slow. They load `artifacts/circuits/transaction2.wasm` and `transaction2.zkey`; do not regenerate those without reading `TRUSTED_SETUP.MD`.

### CI and delivery

[Correctness CI](.github/workflows/verify.yml) runs on every push, pull request,
merge-queue candidate, and manual dispatch, with no branch or path filters. It
checks the revision selected by the event (the proposed merge for pull requests).
A push containing several commits checks its tip; local, unpushed commits do not
trigger GitHub Actions.

The required checks are:

- Workflow syntax and embedded shell validation with actionlint.
- QEDGen spec validation and drift detection against the generated model and
  proof files, followed by all generated unit and property tests. Three existing
  model warnings are explicitly recorded in
  [the warning baseline](.github/scripts/qedgen-warning-baseline.json): missing
  initialization guards and the absent SPL transfer declaration. New warnings,
  changed warning details, all errors, and tool failures fail CI. Existing
  warnings stay visible; remove baseline entries as the model is improved.
- Circuit integrity: every file in `circuits/` and `artifacts/circuits/` must match
  the pinned [`SHA256SUMS`](artifacts/circuits/SHA256SUMS); `transaction2.circom` is
  recompiled with circom 2.2.3 and circomlib 2.0.5 and must reproduce the committed
  `.r1cs` and `.sym` byte for byte; the verifying key exported from
  `transaction2.zkey` must equal `verifyingkey2.json`; and `VERIFYING_KEY` in
  `src/utils.rs` must encode that same key. Changing any circuit artifact therefore
  requires a reviewed `SHA256SUMS` update. The witness `.wasm` is not reproducible
  with circom 2.2.3, so it is pinned by hash and exercised by the real-proof tests.
  The trusted-setup contributions are not re-verified in CI (the Hermez
  `powersOfTau28_hez_final_18.ptau` is no longer hosted at its original URL); run the
  `snarkjs zkey verify` command in `artifacts/circuits/TRUSTED_SETUP.MD` manually.
- A fresh SBF build of `src/`, Clippy correctness lints, all native tests, SOL/SPL
  integration tests with real Groth16 proofs, Mollusk benchmark assertions, and
  doctests. Integration tests run serially because their ALT cache is shared.

CI pins Rust 1.89.0, Agave 3.1.8, platform-tools v1.52 and QEDGen 2.49.0, and uses
the committed lockfiles with `--locked`. Dependency upgrades must include the
appropriate lockfile change. Download caches exclude compiled targets so a stale
program cannot be embedded in the integration tests. Clippy style warnings are
reported; existing formatting differences are not a correctness gate.

After the checks pass, the run delivers `privacy-cash-<sha>` as a downloadable
artifact containing `privacy_cash.so`, the dependency lockfile, checked-out commit,
toolchain versions, circuit artifact hashes and `SHA256SUMS`. Verify the package
with `sha256sum --check SHA256SUMS` inside the extracted directory. Test logs,
including compute-unit measurements, are retained separately. The workflow does
not deploy to a Solana cluster or need a signing key.

To enforce this before merges, configure a GitHub branch ruleset on each protected
branch: require pull requests, require the **Correctness gate** status check,
require the branch to be up to date (or use a merge queue), and restrict bypasses
and direct pushes. Select the status check after the first workflow run. The gate
fails if any prerequisite fails, is cancelled, or is skipped. Workflow files alone
cannot enforce repository settings; these settings must be enabled on GitHub.

These checks preserve behavior covered by the existing assertions; they do not
prove all possible future changes correct. Add regression tests for new behavior.
Mollusk checks execution results and reports CUs, but currently has no CU regression
threshold. QEDGen reconciliation covers `programs/`, not equivalence to `src/`.
Kani currently fails to compile its generated invariant harnesses, and the Lean
spec contains admitted proofs and has no checked-in Lake project. Neither backend
is counted as passing CI verification. Repair and validate those backends before
adding them as mandatory jobs; do not hide failures with `continue-on-error`.

To reproduce the program checks locally with the pinned toolchain installed:

```bash
cargo build-sbf --tools-version v1.52 -- --locked
cargo clippy --locked --lib -- -D clippy::correctness
cargo test --locked --all-targets -- --test-threads=1 --nocapture
cargo test --locked --doc
cargo test --locked --manifest-path programs/Cargo.toml --all-targets
```

### Layout

```
src/                      the deployed program
  instructions/           one file per instruction
  groth16.rs              BN254 verifier + embedded VERIFYING_KEY
  merkle_tree.rs          Poseidon incremental tree
  state/                  zero-copy account structs
  constants.rs            seeds, allowlist, tree height, admin gate
circuits/                 transaction2.circom source
artifacts/circuits/       r1cs, wasm, zkey, verifyingkey2.json
tests/common/             prover, off-chain tree mirror, UTXO model, ALT helpers
privacy_cash.qedspec      formal spec
programs/                 generated verification scaffold — NOT deployed
formal_verification/      Lean proofs
```

`programs/` is a generated model of the program used only by the verification harnesses. It is never deployed; `src/` is the real thing.

---

## QEDGen verification

QEDGen reads `privacy_cash.qedspec` — a precise description of who may call each instruction, what it changes, and what must never happen — and generates a Rust scaffold, property tests, Kani model-checking harnesses, and Lean proofs, then checks that code and spec still agree.

Requires `qedgen` **2.49.0** on PATH (`bash ~/.agents/skills/qedgen/install.sh`) and a git repository. Lean (`elan` + `qedgen setup`) and Kani (`cargo install --locked kani-verifier && cargo kani setup`) are optional; without them those backends warn instead of running.

Run from the repository root:

```bash
# 1. validate the spec                                   (~1s)
qedgen check --spec privacy_cash.qedspec

# 2. confirm spec, code, and proofs have not drifted     (~1s)
qedgen reconcile --spec privacy_cash.qedspec --code programs/ --proofs formal_verification/

# 3. regenerate scaffold, tests, and proofs              (~30s)
qedgen codegen --spec privacy_cash.qedspec --target pinocchio --all --kani-impl

# 4. does the generated crate compile?                   (seconds)
qedgen verify --spec privacy_cash.qedspec --scaffold

# 5. random-input testing                                (~10s)
qedgen verify --spec privacy_cash.qedspec --proptest

# 6. run the generated tests directly                    (~1s)
(cd programs && cargo test --all-targets)

# 7. bounded model checking                              (minutes)
(cd programs && cargo kani --tests)

# 8. Lean proofs — always check for admitted holes
grep -n 'sorry' formal_verification/*.lean
```

Current status: `check` reports no errors and three warnings (exit 1), `reconcile`
is in sync, and all 27 generated unit/property tests pass. Kani fails to compile
the generated invariant harnesses, so no Kani harness executes. `Spec.lean`
contains two `sorry` admissions; no Lake project is checked in to build the Lean
proofs. CI records these limits rather than claiming complete formal verification.

Never hand-edit anything under `programs/` or `formal_verification/` — the next `codegen` run overwrites it. Fix the spec.
