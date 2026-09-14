# Demo Runbook — live local demo, start to finish

Everything runs on your machine: local validator (surfpool), locally deployed
program, local relayer (wrangler), local proving. No devnet dependency, no
faucet limits, no rate limits.

## 0. One-time (already done on this machine)

- `payroll/demo/treasury.json` — funded treasury wallet (500 SOL).
  Import this file into Phantom when the demo browser asks for a private key
  (Phantom → account menu → Import private key → paste the base58 key from
  `solana-keygen show demo/treasury.json --show-private-key`).
- `payroll/demo/employee1.json`, `employee2.json` — funded employee wallets.
- Phantom must point at the local chain: Settings → Developer Settings →
  Change network → Solana → custom RPC `http://127.0.0.1:8899`.

## 1. Start the stack (~1 minute; first wrangler build can take longer)

```bash
cd payroll && bun install && bun run dev &          # web app :5174
zsh payroll/rust-prover-bench/bench/reset-env.sh    # chain + deploy + relayer
```

reset-env ends with `reset done:` and the program id
(`721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr`). If wrangler is still
compiling on first run, wait for `curl localhost:8787/health` to say
`{"status":"ok"}`, then run the three steps it printed manually:

```bash
solana airdrop 500 --url http://localhost:8899 --keypair /tmp/deploy-payer.json <RELAYER_ADDR>
curl -X POST localhost:8787/api/relayer/initialize -H "x-admin-password: local-e2e"
curl -X POST localhost:8787/api/admin/sync       -H "x-admin-password: local-e2e"
```

## 2. Point the app at the local stack

Open http://localhost:5174 → Employer sign in → **Settings** → click
**Local simnet** → Save & reload. The badge must say **relayer up**.

## 3. Start the balance watcher (second terminal)

```bash
cd payroll
bun scripts/watch-demo.mjs --treasury $(solana-keygen pubkey demo/treasury.json)
```

It prints a live table: treasury balance, every employee address in
`demo-payroll.csv`, the relayer fee wallet, and the **shielded leaf count**
(how many private notes have landed). Baseline is set on the first frame —
as the run pays out, rows turn green with ▲ deltas.

## 4. The demo flow

1. Landing page — talk through the four stat cards (902s → 11.3s, 80×, 210/210, 1 signature)
   and the hero widget: *"this is the actual treasurer screen."*
2. Employer sign in → connect Phantom (the imported `treasury.json` account, or any wallet).
   One free signature popup unlocks the vault (message signature, no gas).
3. Low on SOL? Click **Faucet +10** in the toolbar (appears only on the local simnet) —
   airdrops straight to the connected wallet. No terminal needed.
4. Upload `payroll/demo-payroll.csv` — drag & drop works. Review card shows total,
   relayer fee (25 bps), and the deposit you'll sign.
5. Run → sign the deposit popup → watch payouts go queued → proving → relayed →
   confirmed, progress bar glowing to 100% — while the watcher terminal paints each
   employee green with their exact amount.
6. **Click any signature in the progress rows** — Solana Explorer opens **against the
   local cluster** (links follow your Settings RPC), so every demo tx is inspectable:
   instructions, the merkle appends, the relayer as fee payer.
7. Run a second, smaller file: **zero wallet popups** (the vault covers it) —
   the privacy + gasless story in one move.
8. (Private-mode bonus, if enrolled employee wallets exist): flip the
   **Private notes** toggle in review. Payouts land as shielded notes — the
   watcher's leaf counter ticks up instead of employee balances. The employee
   sees the note via their app and claims it gasless.

## 5. Prove it's real (backup slides / terminal)

- Full private loop, asserted end to end (~50s):
  `PROGRAM_ID=721TvnSURopg7FCsP5ZL9WzWMWXxUutehPGJ81bhwQbr bun scripts/e2e-v2.mjs`
- 210-employee bench, one command (needs surfpool with v1 txs; see
  `payroll/rust-prover-bench/bench/README.md`): `run-210.sh`
- The measured story: open `payroll/SPEED-JOURNEY.html` and
  `payroll/BUILD-LOG.html` in the browser.

## Ports

| Service | URL |
|---|---|
| Payroll web app | http://localhost:5174 |
| Relayer (wrangler) | http://localhost:8787 |
| Local validator (surfpool) | http://localhost:8899 |
