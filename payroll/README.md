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

## v2: private payouts (shielded notes)

v2 adds a second payout mode: instead of unwrapping to a public transfer, the
run pays each employee with a **shielded note** only they can spend (the
program's ext=0 transfer — no public SOL moves at all).

- **Recipient enrollment (one time):** each employee enables "Private
  receiving" in the main web app (`frontend`). This signs three short messages
  to publish their note + encryption keys to the backend registry. The payroll
  app's review card has a "Check recipients" button that lists any employees
  not yet enrolled and blocks the run until everyone is.
- **Payout mode:** the review card has a Public / Private notes toggle. In
  private mode every row is paid `transferNoteSOL`/`transferNoteSPL` — the
  employee's exact net lands as a note on their wallet, the relayer fee comes
  out of the vault's notes (no public-side amounts, addresses, or links).
- **Receiving:** employees see the notes in their normal vault balance (the
  frontend "Load notes" action) and can spend or withdraw them like any other
  note. Withdrawing converts to a public transfer and pays the standard relayer
  fee.
- **Receipts** record the note's leaf index and commitment beside the
  transaction signature, so a payroll auditor can point at the exact leaf.

## v2 local end-to-end (simnet)

`scripts/e2e-v2.mjs` runs the whole v2 flow against a local validator and a
local Workers dev server: recipient enrollment, deposit, shielded transfer,
recipient discovery + decrypt, and a gasless withdraw to a fresh address with
an exact-balance assertion.

```bash
# 1. Validator: surfpool on :8899, then deploy the program locally.
#    (The committed declare_id is the devnet program; a local deploy needs a
#    temporary patch of programs/privacy-cash/src/lib.rs to the new address,
#    cargo +stable build-sbf, solana program deploy --program-id <new keypair>,
#    then revert the patch — never commit it.)
surfpool start &                                   # http://127.0.0.1:8899
solana-keygen new --no-bip39-passphrase -o /tmp/payroll-v2-program.json
# patch declare_id -> <pubkey of that keypair>, build, deploy, revert:
cargo +stable build-sbf --manifest-path programs/privacy-cash/Cargo.toml
cp target/sbpf-solana-solana/release/privacy_cash.so target/deploy/privacy_cash.so
solana program deploy target/deploy/privacy_cash.so \
  --program-id /tmp/payroll-v2-program.json --keypair ~/.config/solana/id.json \
  --url http://127.0.0.1:8899

# 2. Workers: .dev.vars (gitignored) with
#    RELAYER_KEYPAIR_JSON=<contents of a funded keypair json>
#    SOLANA_RPC_URL=http://127.0.0.1:8899
#    ADMIN_PASSWORD=local-e2e
cd workers
npx wrangler d1 migrations apply privacy-cash --local
npx wrangler dev --var PROGRAM_ID:<deployed address> --port 8787

# 3. Run it (bun: node cannot resolve the SDK's bundler-style dist).
cd ../payroll
bun scripts/e2e-v2.mjs
```

The script self-funds throwaway wallets via airdrop (falling back to
`FUNDER_KEYPAIR`, default `~/.config/solana/id.json`), tolerates an
already-initialized tree, and exits non-zero if any step fails. The SPL variant
is skipped with a note unless a supported mint has an initialized tree locally.

Env knobs: `BACKEND_URL` (default `http://127.0.0.1:8787`), `RPC_URL`
(default `http://127.0.0.1:8899`), `PROGRAM_ID` (default: the current local
deploy `21iBDT426WmQ3fUHvTWQ6aVPwPnaYik39av2BbQHHVYr` — regenerate whenever
the simnet is rebuilt), `ADMIN_PASSWORD` (default `local-e2e`).

## Ops notes

- SPL payouts require the mint's merkle tree to be initialized. The operator
  does this once from the main frontend's admin card (`initialize SPL tree`)
  — not from this app.
- The relayer takes `withdrawal_fee_rate_bps` per payout (shown in the review
  card); the vault must cover total + fees + a small margin.
- Receipts (with JSON/CSV export) live in this browser's localStorage only;
  on-chain signatures are the source of truth.
- Never `git push` this branch.
