# Private Payroll — v1 Design (public payout mode)

Date: 2026-08-18
Branch: `payroll` (off `workers-migration`; never pushed)
Status: approved design, pre-implementation

## Hard constraints

- **Everything lives in `payroll/` only.** No changes to `sdk/`, `workers/`, `frontend/`,
  `mobile/`, `programs/`, or any other existing folder. This includes documentation —
  this file is the spec of record.
- New branch `payroll`, local only. **No `git push` of any branch** (including old ones).
- The two uncommitted mobile files (`mobile/src/screens/SettingsScreen.tsx`,
  `mobile/src/store.ts`) ride along in the working tree dirty and are never committed here.
- The SDK is consumed exactly as `frontend/` consumes it (`privacy-cash-sdk`), read-only.

## Product

A company treasurer connects a wallet, uploads one payroll file (JSON or CSV) listing
employee addresses and amounts, funds the run from the company's shielded vault, and pays
everyone with **at most one wallet signature** (only when the vault can't cover the run).
Payouts are gasless relayer-signed withdrawals through the existing deployed backend:
employees receive ordinary SOL/SPL at their address; the payout transactions are
ZK-unlinkable to the funding deposit.

Not in v1 (deliberate): shielded recipient notes (v2 — needs an on-chain program change,
see "v2 roadmap"), backend-persisted history, recurring schedules, multi-sig treasury,
employee claiming UI.

## Decisions (all confirmed with the user)

| Topic | Decision |
|---|---|
| Payout mode v1 | Public SOL/SPL at employee address, ZK-unlinkable to deposit. Shielded toggle rendered disabled ("v2") |
| Assets | SOL and SPL (mint selected in UI, e.g. USDC-style 6-decimal token) |
| Signing model | Vault-first; deposit only the shortfall (the single signature). Zero popups when vault covers the run |
| Payout execution | Sequential gasless relayer submissions (`/api/relayer/submit`), relayer-signed |
| Upload formats | JSON and CSV |
| Run history | Browser localStorage only; export JSON/CSV |
| Placement | `payroll/` standalone Vite React app, dark theme matching `frontend/` |

## Why shielded payouts are v2 (recorded so we don't re-litigate)

- Notes today are keyed to the spender's signature-derived keypair (`sdk/src/crypto.ts`
  `deriveFromSignature`); there is no recipient-addressable note scheme. Shielded-to-
  employee transfers need a stealth-note design (recipient registers note + encryption
  public keys; sender encrypts via ephemeral key exchange; V3 note format; SDK scan +
  spend changes).
- The on-chain program rejects pure transfers: `programs/privacy-cash/src/utils.rs:189`
  `check_public_amount` fails for `ext_amount == 0`. Shielded mode requires a program
  change + redeploy and relayer acceptance of `ext_amount == 0` (`workers/src/validate.rs`
  `assert_is_withdraw`).
- The relayer's root history (100) and one-transact-per-tx wire limit are what make the
  v1 sequential payout chain safe without re-proving storm; see "Engine".

## App shape

```
payroll/
  DESIGN.md                  <- this spec
  README.md                  <- run instructions, file-format spec, ops runbook
  package.json               <- vite + react + tailwind; depends on privacy-cash-sdk
  vite.config.ts  tsconfig.json  index.html  tailwind + postcss configs
  src/
    main.tsx  App.tsx  index.css
    lib/
      config.ts              <- backend/circuit/cluster defaults + localStorage overrides
      parse.ts               <- JSON/CSV -> PayrollPlan (validation, dedupe, units)
      engine.ts              <- run orchestrator: fund shortfall, sequential payouts, statuses
      history.ts             <- localStorage receipts, run list, export JSON/CSV
      format.ts              <- lamports/SOL + short-hash display helpers (frontend parity)
    hooks/
      usePayrollClient.ts    <- wallet connect, SDK init/unlock (sign), relayer info
    components/
      WalletBar.tsx  UploadCard.tsx  PlanReviewCard.tsx
      RunProgressCard.tsx    HistoryCard.tsx  SettingsDrawer.tsx
      ui/                    <- card/button/badge/table primitives copied from frontend
  tests embedded per lib module (vitest): parse.test.ts, engine.test.ts, history.test.ts
```

## Payroll file formats

JSON (either shape accepted):

```json
{ "payments": [ { "address": "<base58>", "amount": 1.5, "memo": "Oct salary" } ] }
[ { "address": "<base58>", "amount": 1.5 } ]
```

CSV with header row: `address,amount,memo` (memo optional, may be empty; quoted commas
allowed).

Validation rules (all produce per-row, numbered errors):

- `address`: non-empty, valid base58 ed25519 pubkey (`new PublicKey()` + on-curve check).
- `amount`: number > 0, finite, at most the asset's decimals (9 for SOL, mint decimals
  for SPL; decimals resolved from the mint account).
- Duplicate `address` within a file: rejected (tell the user to merge rows manually —
  two payouts to one address in one run would double fees and risk confusion).
- 1–200 entries per run.
- Human units in the file (1.5 = 1.5 SOL), converted to lamports/raw with
  `Math.round(x * 10^decimals)` and an exactness re-check.

Engine output type:

```ts
type PayrollPlan = {
  fileHash: string          // sha-256 of the uploaded bytes
  asset: { kind: "sol" } | { kind: "spl"; mint: string; decimals: number }
  entries: Array<{ address: string; amountRaw: bigint; amountHuman: string; memo?: string }>
  totalRaw: bigint
}
```

## Engine (`lib/engine.ts`)

Framework-free TypeScript, no React imports, fully unit-testable against a mocked SDK
client. Emits status callbacks; owns no storage (receipts via `history.ts`).

Run phases:

1. **Plan** — parse output plus live fee data: fetch `/api/relayer/info`
   (`withdrawalFeeRateBps`). **The file amount is what the employee receives (net-exact);
   the relayer fee is absorbed by the company.** For each entry solve for the smallest
   `gross ≥ net` with `gross − ceil(gross * bps / 10_000) = net` (deterministic: start at
   `ceil(net * 10_000 / (10_000 − bps))`, adjust down/up until exact — a few iterations),
   mirroring the SDK's `withdrawInternal` fee math (`fee = ceil(gross * bps / 10_000)`,
   recipient gets `gross − fee`). Vault requirement and display total = Σ gross, plus a
   small margin (1 entry-fee) for rounding/index drift.
2. **Fund** — sync vault (SDK `refreshNotes`); `shortfall = Σ gross + margin − vault`.
   If `shortfall > 0`: one client-signed `depositSOL`/`depositSPL` of exactly the
   shortfall, then `waitForNoteIndexed` for the new leaf. Wallet popup rejected →
   abort, nothing sent, run marked `aborted`.
3. **Pay** — for each entry in order: `withdrawSOL/withdrawSPL(gross, address,
   { relay: true })` with the entry's solved `gross` (employee nets exactly the file
   amount) — SDK does note selection, browser-side proving, relayer submit;
   then resync so change notes are spendable for the next entry. Per-entry state machine:
   `queued → proving → relayed → confirmed | failed(reason)`. Confirmation via RPC
   signature status poll with timeout → on timeout stay `confirming` with explorer link.
   Failure semantics: 3 attempts with exponential backoff per entry (retries also cover
   429 sync-ratelimits); after that mark `failed`, continue with the remaining entries.
4. **Settle** — write the run receipt (successes + failures), update history.

Resume: a run's failed entries can be re-run as a new run referencing the original
`fileHash` ("Resume failed" button on a history entry).

Known sequential-chain behavior: change notes only become spendable after their leaf is
indexed, so payouts are inherently sequential; expect ~2–5 s per employee. 200 entries is
the ceiling precisely so a run stays within one sitting (~10–15 min worst case).

SPL note: payouts rely on the SDK's existing ALT reuse path (`ensureAlt`). The very first
SPL run may require one extra one-time wallet signature to create/extend the ALT; after
that, runs are single-signature (or zero). SPL tree for a mint must already be initialized
(ops step, see README); if not, the run fails fast with an actionable error.

## Receipts (`lib/history.ts`)

localStorage key `payroll:history` (versioned `v1`), max 50 runs (FIFO trim).

```ts
type RunReceipt = {
  id: string                // random id
  createdAt: number
  fileHash: string
  asset: PayrollPlan["asset"]
  mode: "public"            // "shielded" reserved for v2
  totalPlanned: bigint
  entries: Array<{
    address: string; amountHuman: string; memo?: string
    status: "sent" | "failed" | "confirming"
    txSignature?: string; error?: string; attempts: number
  }>
  funding?: { depositedRaw: bigint; txSignature: string } | null
  summary: { sent: number; failed: number; total: number }
}
```

Export: JSON (full receipt) and CSV (`address,amount,memo,status,tx_signature,error`)
via blob download. On-chain signatures remain the source of truth; receipts are
convenience only.

## UI

Single-page flow, four cards, dark theme matching `frontend/`:

1. **WalletBar** — connect (same wallet-adapter + `signMessage` unlock pattern as the
   frontend), vault balance per asset, relayer reachability dot.
2. **UploadCard** — drag-drop or paste; format auto-detect; errors listed with row
   numbers; on success shows the plan table (address, amount, memo) + totals.
3. **PlanReviewCard** — asset selector (SOL / SPL mint input), payout-mode toggle
   (disabled, labeled "Shielded — coming in v2"), vault balance vs total, shortfall and
   the exact deposit you will sign, fee estimate breakdown, then **Run payroll**.
4. **RunProgressCard** — overall progress bar, per-entry rows with status chips and
   explorer links, cancel (between entries), and when finished: summary + "Resume
   failed" if any.
5. **HistoryCard** — past runs (collapsed), export buttons, resume-failed.

SettingsDrawer overrides backend URL / circuit base / cluster in localStorage (defaults:
deployed workers backend, existing circuit host, devnet) so a backend move never needs a
redeploy (lesson from the mobile URL rotation).

## Error handling matrix

| Situation | Behavior |
|---|---|
| Parse/validation failure | Row-numbered errors; no partial plans |
| Wallet rejects the deposit popup | Abort before any payout; run marked `aborted` |
| Insufficient vault after deposit failure | Clean abort with explanation |
| Relayer/RPC error on a payout | 3 retries w/ backoff → entry `failed`, run continues |
| Confirm timeout | Entry stays `confirming`, explorer link, no retry (idempotence risk) |
| SPL tree not initialized | Fail fast before funding, actionable message |
| localStorage unavailable | Warn once; run works receiptless |

## Testing

- **Unit (vitest)**: `parse.ts` (valid/invalid JSON + CSV, dupes, units, decimals,
  caps), net-exact gross solving + shortfall math (parity with `withdrawInternal`
  rounding), `history.ts` (trim, export shapes, resume fan-out).
- **Engine**: mocked SDK client with configurable latency and failure injection —
  asserts ordering, per-entry statuses, retry/continue, abort-on-reject,
  resume-failed-only.
- **Manual devnet E2E** (README runbook): 3-employee JSON, 2 SOL each; verify explorer
  links, receipts, employee balances; kill-backend-mid-run → resume failed; SPL run on
  an initialized mint.

## v2 roadmap (out of scope here; separate effort)

1. On-chain: allow `ext_amount == 0` transfers (fee-gated) — program change + redeploy
   strategy (in-place upgrade if the deploy allows, else new program ID + client
   re-pointing).
2. Relayer: accept transfer-kind submits (fee ≥ minimum covering SOL costs).
3. SDK: stealth-note V3 — recipient note-pubkey registration, ephemeral key-exchange
   encryption, scan + spend for received notes. Property: leaked files or even leaked
   note plaintexts never enable spending; only the recipient's signature-derived secret.
4. Payroll app: enable the shielded toggle, employee "receive code" registration page.
