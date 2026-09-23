# privacy-cash-relayer

Signs and pays for shielded spends so the user's wallet never appears on-chain.

## Why it exists

A ZK proof hides which note was spent. It does not hide who submitted the
transaction. A wallet-signed withdrawal names the withdrawing wallet as fee payer
and signer, directly beside the recipient and the amount — which links the deposit
to the withdrawal without breaking any cryptography. The proof is doing real work
and the transaction envelope gives it away.

The user cannot fix this by pre-signing and having someone else broadcast, because
the fee payer is part of the signed message. Whoever pays has to be whoever
compiles. So the client sends a proof and the raw `extData` components, and the
relayer builds, signs and submits.

## What it can and cannot do

Recipient, amount, fee, fee recipient, mint and both ciphertexts are hashed into
`extDataHash`, a Groth16 public input the program verifies. The relayer recomputes
that hash and refuses anything that does not match, so the transaction it builds is
provably the one that was proved.

Its complete set of powers: **refuse, delay, reorder, observe.** Observation is the
real cost and it is irreducible — the operator learns the recipient, the amount,
the request IP and the timing. It cannot steal, redirect, skim or forge, and it
cannot learn which note was spent.

Users are never locked in: the program's `verify_signer` accepts any signer, so a
user can always sign their own withdrawal instead (`selfRelay` in the SDK). That
sacrifices the privacy above but guarantees funds cannot be frozen by an
unavailable or censoring relayer.

## Economics

Every `transact` creates two nullifier marker accounts, 1 byte each. Rent-exempt
minimum is `(128 + 1) * 3480 * 2 = 897_840` lamports apiece, they are never closed,
and the transaction signer pays. So relaying one spend costs about **0.0018 SOL of
unrecoverable rent** — roughly 250x the transaction fee, which is the number that
actually decides whether relaying is viable.

The relayer refuses any request whose fee is below
`2 * 897_840 + 7_000 + RELAYER_FEE_MARGIN_LAMPORTS`. The protocol's own
`validate_fee` enforces a minimum rather than an exact amount, so the SDK raises
small withdrawals to this floor and the arithmetic stays valid on-chain. The
practical consequence is a minimum economic withdrawal size, which the SDK exposes
as `minWithdrawalLamports()`.

Watch `net_lamports` on `/metrics`. Trending negative means the floor is set below
what traffic actually costs.

## Keys

Two accounts, deliberately:

- `RELAYER_KEYPAIR` — the hot signing key. Exposed to the internet, pays
  transaction fees and nullifier rent. Keep it funded but small.
- `RELAYER_FEE_RECIPIENT` — where protocol fees accrue. Startup refuses if it
  equals the signer, because revenue sitting in the hot key defeats the split.

Because the signer fronts rent and is only reimbursed per transaction, it needs an
operating float. The relayer warns below `RELAYER_MIN_SIGNER_BALANCE_LAMPORTS` and,
if you give it `RELAYER_FEE_RECIPIENT_KEYPAIR`, sweeps from the fee recipient back
to the signer automatically. Leave that unset to keep the fee account cold and
sweep by hand.

## Endpoints

| route | purpose |
|---|---|
| `POST /api/relayer/transact` | withdrawals and shielded transfers — the privacy-critical path |
| `POST /api/relayer/swap` | atomic shielded swap as a SIMD-0385 v1 packet |
| `POST /api/relayer/submit` | broadcast an already-signed transaction (deposits, ALT setup) |
| `GET /api/relayer/info` | program id, fee recipient, fee rates, rent constants, fee floor |
| `GET /api/relayer/blockhash` | latest blockhash, so clients need no RPC of their own |
| `GET /api/relayer/alt/{address}` | raw lookup table bytes |
| `GET /health`, `GET /metrics` | liveness and float/solvency counters |

Deposits are rejected by `transact`: the program funds them with
`Transfer { from: signer }`, so relaying one would spend the relayer's balance —
and a deposit is publicly attributable anyway, so there is nothing to hide. They go
to `/submit` wallet-signed.

## Running

```bash
cp .env.example .env    # then fill in RELAYER_KEYPAIR and RELAYER_FEE_RECIPIENT
cargo run --release
```

SPL spends need `RELAYER_ALT_ADDRESS`; without it `/api/relayer/info` reports
`spl_relay_available: false` and the SDK declines to relay SPL rather than silently
falling back to wallet signing.

Point the SDK at it with `VITE_RELAYER_URL` (or `setRelayerUrl()`). It defaults to
the backend URL, which is what the dev shim serves.

## Program upgrade: root-history dedup

The on-chain tree still has 100 root slots. Each completed instruction now writes
**one** of them (both output leaves still go in). Deploy is a program upgrade only:

- Tree PDAs are not resized or reset.
- Honest in-flight proofs already target a complete root and stay valid until that
  root ages out. Users do not re-prove.
- Intermediate roots left in the ring from before the upgrade stay accepted until
  overwritten. After ~100 new transactions the ring is all complete roots.
- Immediate effect: each new tx costs 1 slot instead of 2. The full ~100-tx window
  appears once the old junk rotates out.

## Abuse defenses

Fixed-window rate limits per IP and globally, a request body cap, and an in-flight
nullifier set so two concurrent requests cannot both pass the spent check on the
same note. Errors carry machine-readable codes (`FEE_TOO_LOW`, `UNKNOWN_ROOT`,
`NULLIFIER_SPENT`, `EXT_DATA_HASH_MISMATCH`, …) so clients can branch without
parsing prose.
