# Client SDK slot (NOT IMPLEMENTED)

This folder is the integration point for the **client SDK** — the off-chain code that
generates the ZK proof needed for a withdrawal. The rest of the app (and the relayer
backend) are fully wired; this is the only missing piece.

Today `index.ts` exports stubs:

- `isClientSdkConnected()` → `false`
- `buildWithdrawRequest(params)` → **throws `ClientSdkNotConnectedError`**
- `parsePastedWithdrawRequest(json)` → validates a full proof JSON for manual testing

A real withdrawal therefore returns the backend's `InvalidProof` until you implement
the stub. The relayer still signs + submits + pays gas; it just needs a valid proof.

## What to implement here

`buildWithdrawRequest({ kind, recipient, extAmount, fee, mint? })` must return a full
`WithdrawRequest` (see `src/lib/types.ts`). Concretely:

1. **Load the note** the user is spending: `{ nullifier, secret, commitment }` (a UTXO
   from `/api/notes` once that endpoint exists, or generated client-side at deposit).
2. **Fetch the Merkle path** for the note's leaf index:
   `GET /api/merkle/{treeKey}/proof/{leafIndex}` → `{ path_elements[26], path_indices[26] }`.
   - `treeKey` is `"sol"` for native SOL, or the mint base58 for SPL.
3. **Run the circom prover** (WASM build of the withdraw circuit) to produce
   `proof_a` (64 B hex), `proof_b` (128 B hex), `proof_c` (64 B hex), plus the public
   inputs the circuit exposes: `root`, `public_amount`, `ext_data_hash`,
   `input_nullifiers[2]`, `output_commitments[2]`.
4. **Compute the witness-correct `ext_data_hash`** — `SHA256` over
   `recipient(32) | ext_amount.le(8) | enc1.len.le(4) | enc1 | enc2.len.le(4) | enc2 | fee.le(8) | fee_recipient(32) | mint(32)`,
   compared as `Fr::from_le_bytes_mod_order(sha) == Fr::from_be_bytes_mod_order(proof.ext_data_hash)`.
   For SOL the `mint` is the sentinel `0x00…01`; for SPL the `fee_recipient` is the
   relayer's fee ATA (from `/api/relayer/info`). Get both from the relayer info first.
5. **`public_amount`** for a withdraw = `-(ext_amount_abs + fee)` as a big-endian
   32-byte field element.
6. Return `{ kind, proof_a, proof_b, proof_c, root, public_amount, ext_data_hash,
   input_nullifiers, output_commitments, ext_amount: -extAmount, fee,
   encrypted_output1, encrypted_output2, recipient, mint? }`.

`ext_amount` is **negative** for withdrawals. `nullifier_bumps` are NOT sent — the
backend derives them.

## Reference
- Circuit + verifying key live in the on-chain program (`programs/privacy-cash/src/utils.rs`).
- Relayer info (fee_recipient, mints, fee rates): `GET /api/relayer/info`.
- Merkle proof: `GET /api/merkle/{treeKey}/proof/{leafIndex}`.
- The withdraw endpoint: `POST /api/relayer`.
