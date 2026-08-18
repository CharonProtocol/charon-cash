# Privacy Payroll

One file in, salaries out — with one wallet signature at most.

The treasurer uploads a JSON or CSV payroll file, the app spends the company's
shielded (private) vault first, and — only if the vault can't cover the run —
asks for **one** signature to deposit the shortfall. Every payout is then a
gasless relayer-signed withdrawal: employees receive ordinary SOL/SPL at their
address, and the payout transactions are ZK-unlinkable to the funding deposit.

Run `payroll/DESIGN.md` for the full product/design record. This folder is
self-contained: nothing outside `payroll/` is modified by this app.

## Run it

```bash
cd payroll
bun install
bun run dev        # http://localhost:5174
bun run test       # vitest unit suites
bun run build      # typecheck + production build
```

Defaults point at the deployed Cloudflare Workers relayer and devnet. Override
them in the in-app Settings drawer (stored in localStorage, reloads on save).

## Payroll file formats

JSON (either shape):

```json
{ "payments": [ { "address": "<base58 pubkey>", "amount": 1.5, "memo": "Oct salary" } ] }
[ { "address": "<base58 pubkey>", "amount": 1.5 } ]
```

CSV with header row (memo optional):

```csv
address,amount,memo
9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM,1.5,"Doe, John"
```

Rules: valid Solana pubkeys; amounts > 0 with at most the asset's decimals
(9 for SOL); no duplicate addresses; 1–200 entries. **The file amount is exactly
what the employee receives** — relayer fees are added on top and paid by the
company vault.

## Devnet E2E checklist

1. `bun run dev`, connect a devnet wallet with SOL.
2. First run (empty vault): upload a 3-row file (e.g. 2 SOL each), SOL asset.
   - Review card shows fees + the deposit you will sign.
   - Run: approve the derivation signature, then the deposit transaction.
   - Watch payouts go queued → proving → relayed → confirmed, one by one.
3. Verify each explorer link on devnet and the employees' balances.
4. Refresh the page — vault now shows the remaining change; run a second,
   smaller file: **zero wallet popups** (vault covers it).
5. Failure drill: stop the backend URL in Settings (bogus URL), run a file,
   entries fail after 3 retries; restore the URL, "Resume failed" re-pays only
   the failed rows.
6. SPL run: pick a mint whose tree is initialized (see below), load decimals,
   run. The first SPL run may ask for one extra one-time signature to set up
   the payout address lookup table.

## Ops notes

- SPL payouts require the mint's merkle tree to be initialized. The operator
  does this once from the main frontend's admin card (`initialize SPL tree`)
  — not from this app.
- The relayer takes `withdrawal_fee_rate_bps` per payout (shown in the review
  card); the vault must cover total + fees + a small margin.
- Receipts (with JSON/CSV export) live in this browser's localStorage only;
  on-chain signatures are the source of truth.
- Never `git push` this branch.
