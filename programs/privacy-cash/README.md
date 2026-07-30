# Privacy Cash On-Chain Program

Pinocchio-based Solana program for Privacy Cash’s shielded UTXO pool: verify
Groth16 proofs, lock nullifiers, append Poseidon commitments, and move SOL or
SPL tokens through the vault.

## Program ID

`5GcqZ4aZ3xF87wQF5pFmHHYAk73Hcww1r8414KdeUJ9P`

## What Lives On Chain

The program stores only pool verification and vault state:

- global fee config
- per-pool Merkle tree frontier + root history (SOL and per-mint SPL)
- SOL vault PDA / SPL pool ATAs
- nullifier PDAs (spent markers)

It does not store plaintext balances, viewing keys, or decrypted notes. Those
remain client-side.

## Mental Model

1. **Deposit** — user funds the vault and the tree gains **two** commitments.
2. **Withdraw** — user proves knowledge of notes, publishes nullifiers, receives
   funds, and the tree gains two new commitments.
3. Chain sees proofs, nullifiers, and commitments.

```text
  Wallet / SDK                     This program                         Vault
  ────────────                     ────────────                         ─────
  build ZK proof  ──tx──►  verify proof + root + fees
  sign + submit            create nullifier PDAs
                           append 2 commitments          ◄──►  SOL PDA or SPL ATA
                           transfer lamports / tokens
```

## Accounts

- `GlobalConfig` PDA: `"global_config"`
  - authority
  - deposit / withdrawal fee rates (bps)
  - fee error margin
- `MerkleTreeAccount` PDA: `"merkle_tree"` (SOL) or `"merkle_tree" + mint` (SPL)
  - next leaf index, subtree frontier (height 26)
  - circular root history (100 roots)
  - max deposit amount + authority
- `TreeTokenAccount` PDA: `"tree_token"` — SOL vault metadata
- SPL vault — ATA of `GlobalConfig` for the mint
- `NullifierAccount` PDA: `"nullifier0|1" + nullifier_hash` where its existence = spent

## Instructions

| Disc | Instruction | Purpose |
| ---: | --- | --- |
| 0 | `Initialize` | Create SOL tree + SOL vault + global config |
| 1 | `InitializeTreeAccountForSplToken` | Create per-mint SPL tree |
| 2 | `Transact` | Deposit / withdraw  **SOL** |
| 3 | `TransactSpl` | Deposit / withdraw  **SPL** |
| 4 | `UpdateGlobalConfig` | Authority updates fee rates / margin |
| 5 | `UpdateDepositLimit` | Authority updates SOL max deposit |
| 6 | `UpdateDepositLimitForSpl` | Authority updates SPL tree max deposit |

### `ext_amount` (Transact / TransactSpl)

| Value | Meaning |
| --- | --- |
| `> 0` | Deposit into vault |
| `< 0` | Withdraw `\|ext_amount\|` from vault |
| `= 0` | Internal transfer (still 2-in / 2-out notes) |

## Transact Payload

After the 1-byte discriminator:

```text
[ Proof (480 bytes) ]
  proof_a | proof_b | proof_c
  root | public_amount | ext_data_hash
  input_nullifiers[2] | output_commitments[2]
[ ExtDataMinified (16 bytes) ]
  ext_amount: i64 LE | fee: u64 LE
[ encrypted_output1: u32 LE length + bytes ]
[ encrypted_output2: u32 LE length + bytes ]
[ nullifier_bump0: u8 ][ nullifier_bump1: u8 ]
```

### Validation order (both SOL and SPL)

1. Signer + PDA / program id checks  
2. Create nullifier0 + nullifier1 PDAs (double-spend lock)  
3. Root in `root_history`  
4. `ext_data_hash` matches recipient / amounts / enc / fee / mint  
5. `public_amount` matches on-chain formula from `ext_amount` + fee  
6. Fee within configured rate ± margin  
7. Groth16 verify  
8. Transfer funds, then append two output commitments  

## Current Reality

- SOL and SPL transact paths are live
- Nullifier PDAs and root history checks are live
- Fee checks and Groth16 verification are live
- Demo defaults leave Initialize open and allow all SPL mints
- Day-to-day demo flow is **wallet-signed** deposits/withdraws; relayer submit
  is deferred at the product layer

## Module Map

| Path | Responsibility |
| --- | --- |
| [`src/lib.rs`](./src/lib.rs) | Entrypoint; route by discriminator |
| [`src/instructions/`](./src/instructions/) | One file per instruction |
| [`src/state/`](./src/state/) | Account layouts + `TransactArgs` / `Proof` |
| [`src/merkle_tree.rs`](./src/merkle_tree.rs) | Incremental Poseidon tree, root history |
| [`src/utils.rs`](./src/utils.rs) | Fees, `ext_data_hash`, Groth16 verify |
| [`src/helper.rs`](./src/helper.rs) | PDA checks, nullifier init |
| [`src/constants.rs`](./src/constants.rs) | Seeds, height, allowlists, admin |
| [`src/error.rs`](./src/error.rs) | Custom program errors |

## Build and Test

```bash
# From repo root
cargo build-sbf --manifest-path programs/privacy-cash/Cargo.toml

# declare_id! MUST equal the program keypair pubkey
solana program deploy target/deploy/privacy_cash.so \
  --program-id target/deploy/privacy-cash-program.json \
  --url localhost
```

## Errors (quick decode)

| Custom | Name | Typical cause |
| ---: | --- | --- |
| 0 | `Unauthorized` | Wrong authority |
| 1 | `InvalidMintAddress` | Mint not allowlisted |
| 5 | `UnknownRoot` | Stale / wrong Merkle root |
| 6 | `ExtDataHashMismatch` | Wrong recipient/ATA/mint/enc hash |
| 7 | `InvalidPublicAmountData` | Circuit amount ≠ on-chain formula |
| 8 | `DepositLimitExceeded` | Deposit above tree max |
| 11 | `InvalidFeeAmount` | Fee too low |
| 14 | `InvalidProof` | Groth16 failed |

Simulation log **“instruction requires an initialized account”** usually means
the tree or global config was never created — run Initialize / Initialize SPL
first.


