> Current handoff: [HANDOFF.md](HANDOFF.md), updated 2026-10-17. Earlier dated
> checks below are historical evidence, not current balances or leaf counts.

# Devnet verification

Verified on 2026-10-16 (Asia/Kolkata). The program is deployed and initialized;
`charon.cash` and frontend hosting have not been changed.

Public addresses, signatures, roots, and verification results are recorded in
[`deployments/devnet.json`](deployments/devnet.json).

| Setting | Value |
| --- | --- |
| Program | `7CsXQpehxTrhuX53zNgFLNdRiRLKfkkUcCX6Uy8DxzJ5` |
| Upgrade and configuration authority | `GAn8V81NM8Qkmyds8RNDM6GVwruEW31dDoVDpC9CWJz1` |
| SOL tree | `226ryKAyU83wGQsBNENwfS94XVrj6krxUcsq819jKK7a` |
| SOL vault | `Z3dyvJSZT6w41xLn8azdy438KkkWqNmqWcgpLjEURjb` |
| Global configuration | `H7u4opLpz6CVHwgkFpt88tYJZKczbybqxsoCTFcq9kRg` |
| Test mint, 6 decimals | `3ZFLKuGzHRKtd5WyfBkrP3jtcK4jTGYoHQ4KVUtfLZKT` |
| Lookup table | `7aPvfLCDc1XL4CzEstrDazYDupmmMPyLA2ttbnfFY27r` |

The test mint is a dedicated devnet asset, not real USDC or USDT.

## Evidence

- Locked SBF build with platform tools v1.52 passed.
- 65 local program tests passed: library, Merkle history, SOL, and SPL.
- All 28 SDK tests passed, including real WASM proofs and encryption tests.
- The downloaded on-chain executable matches the tested 91,064-byte binary;
  the remaining program allocation is zero padding. Binary SHA-256:
  `4e63297f1b9f08eb69847c6f30624803cf04e2a22869fbada5044f7f413b57ae`.
- Real devnet SOL and SPL deposit → private transfer → withdrawal transactions
  confirmed. Each operation appended exactly two commitments and one history
  root, matching the locally computed Poseidon root.
- Deployment and all six successful smoke transactions were independently
  checked as finalized. The SOL vault contains only rent, and the SPL vault
  contains zero tokens after the round trips.
- Each withdrawal delivered exactly 10,000,000 base units to the test recipient.
  Deposits were 10,025,000 base units, including the eventual 25,000-unit fee.
- Recipient encryption/decryption passed; the original sender's encryption
  service could not decrypt the transferred note.
- Invalid proofs failed with custom error 14. Repeated spends failed with
  `AccountAlreadyInitialized`. Both checks used signed devnet simulations and
  verified that tree state remained unchanged.

This verifies direct program transactions using the SDK's encryption and WASM
prover. The owner subsequently reported successful local browser flows. Hosted acceptance
remains outstanding; see HANDOFF.md for the current status.

## Repeat locally

The authority defaults to `~/.config/solana/id.json`. Override it with
`PAYER_KEYPAIR`. Both scripts deliberately use the public devnet RPC and never
request airdrops. Setup does not deploy or upgrade the program.

```bash
# Verify/reuse initialized accounts and create any missing devnet setup.
node sdk/scripts/devnet-setup.mjs

# Send small real devnet transactions; requires Bun for TypeScript imports.
bun sdk/scripts/devnet-smoke.ts
```

The scripts use `target/deploy/devnet.json` for this machine's deployment state.
Smoke results are saved incrementally to `target/deploy/devnet-smoke.json`.
The smoke test can run against a nonempty tree: paths for its new notes come
from the existing on-chain frontier. Run it without concurrent pool writes so
its exact next-index and root assertions remain meaningful.

The initial upload hit the public RPC's rate limit with `--use-rpc`.
Deployment succeeded using `--use-quic` with the same persistent buffer.
Lookup-table creation uses an ancestor in the slot-hash sysvar to accommodate
RPC-node skew; the smoke test also adds its recipient addresses to fit SPL
transactions within the 1,232-byte limit.

Local deployment files are gitignored under `target/deploy/`:

- `devnet-program-keypair.json`: program address keypair; retain it.
- `devnet-buffer-keypair.json`: resumable deployment buffer keypair.
- `devnet-recipient.json`: smoke-test recipient wallet.
- `devnet-privacy_cash.so`: the tested and deployed binary.
- `devnet-onchain.so`: downloaded executable for comparison.
- `devnet-program-tests.log` and `devnet-sdk-tests.log`: local test logs.

The upgrade authority remains the CLI wallet; it is distinct from the program
address keypair. Keep private key files out of public deployment records.

## Local frontend against devnet (no hosting or deployment)

Work is on `integration/devnet`. Current status and remaining tasks are in [HANDOFF.md](HANDOFF.md). The frontend and SDK now share the
program, fee recipient, lookup table, and test mint in `frontend/.env.devnet`.
The dashboard shows Devnet and offers SOL and TEST (the dedicated 6-decimal
Charon test token, not USDC). Jupiter and payroll remain unavailable.
Explorer receipts use `cluster=devnet`. IndexedDB notes and scan cursors use a
devnet-specific database, so localnet notes do not appear as devnet balances.

From the repo root:

```bash
bun run --cwd frontend dev:devnet
# http://localhost:5173/#dashboard — select Devnet in your browser wallet.
```

The launcher explicitly loads `.env.devnet`; an existing localnet `.env` cannot
override it through Bun's automatic env loading. Put public overrides such as a
browser-safe RPC URL or backend URL in `frontend/.env.devnet.local` (ignored).
Keep Yellowstone credentials and signing keys in the backend only.
The default backend URL is empty, so Vite proxies API requests to the local
backend on port 8080. The SDK's registration, notes, proofs, deposits, and
relayed operations all use that same configured URL, including its worker.

The devnet client checks `/api/relayer/info` before requesting a wallet sign-in:
program ID, fee recipient, and the test mint must match. This catches an old
localnet backend. It is a configuration check, not proof that the indexer is
caught up or that a browser transaction has succeeded.

Start the isolated database with `docker compose -p charon-devnet -f compose.devnet.yml up -d db`,
then run `node sdk/scripts/devnet-backend.mjs`. The runner reads optional
`backend/.env.devnet` provider overrides and creates a **separate relayer keypair**
if missing. Fund that key with devnet SOL before testing private transactions. The fee recipient is the deployment
authority; the backend explicitly refuses to use that same key as its signer.
Keep the operator password unset during browser testing. The local runner leaves
operator routes disabled and automatic fee-account sweeping off.

```bash
docker compose -p charon-devnet -f compose.devnet.yml up -d db
node sdk/scripts/devnet-backend.mjs
```

The separate `charon_devnet` Postgres database listens on localhost:5434. Migrations run automatically.
Do not use `run.sh` for this workflow: it deploys to Surfpool and replaces local
configuration. Backend startup now restores trees from Postgres, performs ordered paginated
RPC replay, and verifies leaves/roots against chain before opening port 8080.

Local verification commands (none deploy anything):

```bash
bun run --cwd frontend test
bun run --cwd frontend lint
bun run --cwd frontend build:devnet
bun test --cwd sdk
# Read-only checks: RPC cluster, executable program, ALT, backend configuration,
# and both indexed roots/leaf counts versus the on-chain trees.
bun run --cwd frontend check:devnet
```

`check:devnet` exits nonzero for missing services or mismatched state. It reads
`.env.devnet` and optional `.env.devnet.local`, never loads a signing key, and
never sends a transaction. Passing it still does not replace wallet testing.
The public devnet RPC can rate-limit reads; a browser-safe dedicated devnet RPC
can be supplied in `.env.devnet.local`.

## What remains before calling the full app devnet-ready

The **on-chain privacy program is already deployed**, including SOL/SPL pools,
vaults, global configuration, the test mint, and the lookup table. Its SOL/SPL
privacy operations have direct SDK/on-chain smoke evidence above. A new program
deployment is not required merely to connect the frontend.

The following off-chain services and integration work remain:

| Component | What remains |
| --- | --- |
| Backend API + relayer | Local integration is complete. Host the Rust service over HTTPS with devnet RPC/program/mint/ALT configuration. Registration and note/proof APIs are part of this service. |
| Relayer hot wallet | Dedicated signer funded by the owner; last independent balance was 5 devnet SOL. Transfer the key securely to the host or fund a replacement; keep it separate from the deployment authority. |
| Postgres | Isolated local database is working. Provision hosted persistent storage/backups and migrate local registrations if retaining users. |
| Indexer | Local testing supports RPC-only polling with `INDEXER_RPC_FALLBACK=true`. Yellowstone is optional. Both paths backfill history before serving the API. Supply a devnet provider with sufficient historical coverage. |
| Merkle recovery | Implemented reconstruction of the derived RocksDB cache from ordered Postgres commitments, with gaps rejected and startup root/leaf-count checks against chain. Local stop/start recovery passed; repeat after hosting. |
| History backfill | Implemented cursor-based pagination and oldest-first replay. Missing transactions and RPC errors stop replay rather than skipping leaves; polling and streaming no longer write concurrently. |
| Browser acceptance | Owner reports local flows work. Record/repeat two-wallet acceptance on the hosted origin before DNS cutover. |
| Frontend hosting | Only after local acceptance: host the frontend with the correct API URL plus COOP/COEP headers and the circuit/WASM assets. Do not point `charon.cash` at it yet. |
| Jupiter swaps | Configured program `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` was nonexecutable on devnet during deployment verification. Backend quotes target mainnet. Keep Jupiter disabled; test real swaps on a local mainnet fork or mainnet separately. |
| Payroll | The dashboard currently disables payroll. It has no full devnet browser acceptance evidence and is outside this integration. |

Until those checks pass, the accurate statement is: **the privacy program is on
devnet; the frontend is wired for local devnet testing; the full hosted app and
Jupiter swaps are not verified on devnet.**

No on-chain deployment, frontend hosting, domain change, or devnet transaction
was performed as part of this frontend wiring work.

## Frontend integration verification (2026-10-16)

- Frontend: 28 tests passed, including devnet profile/SDK address agreement,
  TEST selection/decimals, explorer links, and rejecting a mismatched backend.
- SDK: 28 tests passed, including real WASM proof generation.
- Frontend lint, TypeScript check, and devnet production build passed.
- The local devnet server returned HTTP 200 and both COOP/COEP headers.
- Read-only live checks passed for the devnet genesis hash, executable program,
  and active lookup table. Backend and indexed-root checks could not pass because
  no backend was listening on local port 8080.
- At this earlier automated checkpoint, no browser automation surface was
  available. The owner subsequently reported successful local wallet flows.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the local commands and hosted release sequence.

## Local backend verification (2026-10-16)

The isolated Postgres database is running on localhost:5434. The backend now
runs on localhost:8080 and the Vite proxy successfully returns its relayer info.
Ordered replay recovered all 12 SOL leaves and 6 TEST leaves; the live readiness
check passed all six program/ALT/backend/root checks. The backend's 29 tests pass,
including multi-page replay, RPC errors, and Merkle cache reconstruction.

The dedicated relayer is `FExUemxgjLd7dM6hkwwjZkuKehE2Rw1TnDHFN8i5eBBv`.
Its key is ignored at `target/deploy/devnet-relayer.json` with mode 0600. The public
airdrop initially failed; the owner subsequently funded it and an independent
check observed 5 devnet SOL. The owner also confirmed the private Helius settings
are now in ignored `backend/.env.devnet`. Transfer both privately for hosting.

A full backend stop/start preserved all 12 SOL and 6 TEST leaves; both roots
matched chain after restart. SDK registration and viewing-key lookup also passed
through the frontend proxy using a generated local test identity. No on-chain
transaction was sent by that API check.
