# Charon devnet handoff

Updated: 2026-10-17. Branch: **`integration/devnet`**.

## Current outcome

The privacy program is deployed and initialized on Solana devnet. The frontend,
SDK, backend API, relayer, indexer, and isolated Postgres database have been wired
and exercised locally against that deployment. The owner reported successful
local wallet flows and funded the dedicated relayer. Helius configuration has
been moved into ignored `backend/.env.devnet` according to the owner.

**What is not done:** external hosting, a hosted staging acceptance run, HTTPS /
reverse-proxy configuration, production database provisioning/backups, and DNS
cutover for `charon.cash`. AWS/EC2 was discussed; no hosting platform or instance
was selected or provisioned. No new deployment or program upgrade is needed
merely to host the existing devnet app.

Jupiter swaps and payroll remain disabled. This handoff does not establish
mainnet readiness.

## Completed work

| Area | Completed |
| --- | --- |
| On-chain program | Devnet program ID and canonical PDA bumps match the deployed binary. SOL/SPL pools, vaults, global configuration, test mint, and ALT are initialized. |
| Chain evidence | Real SOL and SPL deposit, private transfer, and withdrawal smoke transactions; invalid-proof and repeated-spend rejection checks. Public addresses and transaction evidence are in `deployments/devnet.json`. |
| Frontend | Explicit devnet launcher/profile, SOL + clearly labelled TEST assets, devnet explorer receipts, mismatch checks before wallet sign-in, Jupiter gate, and separate devnet note storage. |
| SDK | Configurable backend origin, supported test mint, and storage namespace, including worker usage. Tracked distribution files reflect these changes. |
| Backend/indexer | Ordered paginated RPC replay from a saved cursor, RPC-only local mode, restoration of derived Merkle trees from Postgres, chain root/leaf-count checks before API startup, and catch-up after Yellowstone subscription/reconnection. |
| Local services | `compose.devnet.yml` provisions a separate persistent Postgres database on localhost:5434. The backend runner binds to localhost:8080. Vite serves the frontend on port 5173 and proxies API requests. |
| Relayer | Separate hot signer created and funded by the owner. Last independent balance check observed 5 devnet SOL; this is a historical balance, not a guaranteed current float. |
| Verification | Program, frontend, SDK, and backend regression checks; live pool-root checks; backend restart recovery; SDK registration/viewing-key lookup through Vite. Owner separately confirmed the local wallet flows work. |

## Public addresses

`deployments/devnet.json` is the deployment record; `frontend/.env.devnet` is a
**public** build profile derived from it.

| Item | Address |
| --- | --- |
| Program | `7CsXQpehxTrhuX53zNgFLNdRiRLKfkkUcCX6Uy8DxzJ5` |
| Upgrade/configuration authority and fee recipient | `GAn8V81NM8Qkmyds8RNDM6GVwruEW31dDoVDpC9CWJz1` |
| SOL tree | `226ryKAyU83wGQsBNENwfS94XVrj6krxUcsq819jKK7a` |
| SOL vault | `Z3dyvJSZT6w41xLn8azdy438KkkWqNmqWcgpLjEURjb` |
| Global configuration | `H7u4opLpz6CVHwgkFpt88tYJZKczbybqxsoCTFcq9kRg` |
| TEST mint (6 decimals, not USDC) | `3ZFLKuGzHRKtd5WyfBkrP3jtcK4jTGYoHQ4KVUtfLZKT` |
| TEST tree | `GKawQ6u5LKM2wJMV5AS1p6LQ7HUxvHa28tG8qmqh2JHR` |
| Lookup table | `7aPvfLCDc1XL4CzEstrDazYDupmmMPyLA2ttbnfFY27r` |
| Dedicated relayer signer | `FExUemxgjLd7dM6hkwwjZkuKehE2Rw1TnDHFN8i5eBBv` |

## Private material: obtain separately from the owner

The following must not enter Git or frontend build variables:

- `backend/.env.devnet`: private Helius RPC and any backend provider settings.
- `target/deploy/devnet-relayer.json`: funded relayer signing key (mode 0600).
- Program/authority keypairs and optional smoke-test recipient keys under ignored
  `target/deploy/`; the deployment authority also exists outside the repository.
- Database credentials, database dumps, and any provider tokens.

`backend/.env` is also ignored. `backend/.env.devnet.example` contains public
example values only. The frontend's tracked `.env.devnet` contains public
addresses and the public devnet RPC; do not confuse it with the private backend
file. The example was sanitized before this handoff commit.

**On a new machine:** securely install the existing funded relayer key, or
explicitly create and fund a replacement. If the default key is missing, the
runner creates a new **unfunded** key. It cannot recover the existing funded key
from its public address. A new key may also require checking its token accounts
and lookup-table coverage.

## Reproduce the local setup

Known development tools: Node 24.10.0, Bun 1.4.2, Rust 1.97.1, Docker Compose,
and PostgreSQL 16. The frontend includes the existing WASM prover builds and
verifies/copies circuit artifacts at build time. Normal app startup does not
require Solana program deployment tools.

```sh
git clone --branch integration/devnet git@github.com:CharonProtocol/charon-cash.git
cd charon-cash
bun install --frozen-lockfile
# Fresh clone only: create the ignored backend settings file, then edit privately.
cp backend/.env.devnet.example backend/.env.devnet
```

Set `SOLANA_RPC_URL` in that private file to a **devnet** provider endpoint.
`INDEXER_RPC_FALLBACK=true` selects RPC-only indexing; Yellowstone is optional.
Retain the example's deployed addresses and local database settings. The runner
loads `backend/.env.devnet` explicitly; editing only `backend/.env` does not
replace the runner's defaults. Keep `ADMIN_PASSWORD` unset for operator routes
to remain disabled. Automatic fee-account sweeping is disabled by default.

Install the funded relayer key securely before starting, then run:

```sh
# Terminal 1: new, isolated local database with persistent storage.
docker compose -p charon-devnet -f compose.devnet.yml up -d db
# Terminal 1: API/indexer/relayer. Builds the backend if necessary.
node sdk/scripts/devnet-backend.mjs
# Terminal 2: frontend / SDK / circuit assets.
bun run --cwd frontend dev:devnet
# Terminal 3: read-only deployment + backend-root checks.
bun run --cwd frontend check:devnet
```

Open `http://127.0.0.1:5173/#dashboard`; select Devnet in the wallet. The backend
restores its derived Merkle cache, backfills history, and checks roots against
chain before opening port 8080. Public RPC may rate-limit backfill; use Helius
and restart after correcting provider issues. Replay resumes from Postgres.

`frontend/.env.devnet.local` can override public frontend settings. Never put the
private Helius credential there. An empty `VITE_BACKEND_URL` uses the Vite proxy
to localhost:8080. The launcher avoids stale localnet `.env` values overriding
its devnet profile.

The default database password is deliberately local-only. If changing
`DEVNET_DB_PASSWORD` for Compose, also set the matching backend `DATABASE_URL`.
Do not remove the database volume if preserving registrations and indexed notes.

**Do not use `run.sh` for this workflow:** it configures/deploys to Surfpool and
replaces local settings. `devnet-setup.mjs` and `devnet-smoke.ts` are optional
operator tools that can send real devnet transactions; they are not startup
requirements. They also need ignored deployment state/key files absent from a
fresh clone. See `DEVNET.md` before using them.

## Fresh checks before handoff commit (2026-10-17)

- Frontend: 28 tests passed; lint and devnet production build passed.
- SDK: 28 tests passed, including real WASM proof generation.
- Backend: 29 tests passed. Mock-RPC tests required local socket access outside
  the sandbox; their initial permission-only failures were resolved by rerunning
  with that access.
- Program: 71 release-mode tests passed; see DEVNET.md for deployment
  evidence. No real devnet smoke transactions were rerun during this handoff.
- Build warnings: existing Rust warnings and large frontend chunks remain.

## Checks for the recipient

```sh
bun run --cwd frontend test
bun run --cwd frontend lint
bun run --cwd frontend build:devnet
bun test --cwd sdk
# The reduced debug configuration saves native RocksDB build space.
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 CXXFLAGS=-g0 \
  cargo test --manifest-path backend/Cargo.toml --locked --offline -j 2
```

Remove `--offline` on a new machine to allow Cargo to download locked dependencies.
The backend regression tests bind mock HTTP servers to localhost; restrictive
sandboxes must allow those sockets. Native RocksDB compilation needs additional
disk space and a C/C++/libclang toolchain. Do not build the Rust backend with
large debug symbols on a nearly full disk or tiny server.

The read-only `check:devnet` script compares both indexed roots/leaf counts with
chain and verifies the program/ALT/backend configuration. It does not establish
relayer funding or replace wallet acceptance testing. The last independently
verified recovery snapshot had 12 SOL leaves and 6 TEST leaves; later user
transactions can legitimately increase these counts.

Before hosting, capture two-wallet SOL/TEST transaction signatures and repeat
registration, deposit/send, shielded transfer, withdrawal, reload/reconnect, and
backend restart checks. The owner has reported local acceptance; a hosted origin
still requires its own acceptance run.

## Remaining work, in order

1. **Choose hosting and staging hostname.** AWS EC2 is one option discussed, not
   a selected or provisioned service. Establish the account, budget, server size,
   region, and domain/DNS access with the owner. Do not assume Free Tier eligibility.
2. **Prepare deployable services.** Package the Rust backend, frontend static
   build, and HTTPS proxy with restart supervision. `compose.devnet.yml` currently
   defines only the local database, not a complete production stack.
3. **Provision persistent storage and secrets.** Create the hosted Postgres
   database with a new password and backups; securely install Helius and the
   funded relayer key. Use a writable backend working directory for the derived
   Merkle cache. Run one backend/indexer writer per database/cache.
4. **Migrate registrations and data.** If preserving local users, export/import
   the local Postgres database. Chain replay can reconstruct commitments and
   encrypted outputs, but cannot recover off-chain wallet registrations/viewing
   keys. Test backup restoration before relying on it.
5. **Configure HTTPS and routing.** Serve frontend and API from the same origin;
   proxy `/api/*`, `/health`, and `/indexer/*` to the backend. Keep database and
   backend ports private. Supply COOP/COEP headers and all worker/WASM/circuit
   assets. Leave operational `/metrics` private.
6. **Verify the hosted release.** Run read-only checks, two-wallet acceptance,
   restart recovery, and relayer/indexer monitoring on the staging origin. The
   browser wallet, HTTPS, and cross-origin isolation need verification there.
7. **Release with the owner's approval.** Change `charon.cash` only after staging
   acceptance. Keep a previous backend/static build for rollback without deleting
   the database.

`DEPLOYMENT.md` gives the detailed hosting sequence. No hosting, DNS, or program
upgrade was performed for this handoff.

## Known limits

- Jupiter Swap targets mainnet infrastructure and is disabled on devnet. Payroll
  is also disabled and is outside the verified local privacy flow.
- The relayer fee-floor check is currently commented out; private transfers
  consume its SOL float. Plan funding/alerts instead of assuming fee revenue
  covers rent and transaction costs.
- Proofs are generated in the browser. Production must preserve the isolation
  headers and serve every proving asset, not just the frontend HTML/JavaScript.
- Backend compilation emits existing warnings. The frontend build warns about
  large chunks; these warnings were not part of the devnet integration scope.
- `bench-kit/` and `payroll/` are unrelated local work and intentionally excluded
  from this branch's handoff commit.
