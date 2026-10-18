# Charon Protocol — Cofounder Update Script (90 seconds)

Seven slides, one breath each section, done in ninety seconds. The deck's built-in
speaker notes (press **N**) carry these exact lines — advance with → and read if
you need to. Word count ≈ 180 ≈ 85 seconds at a calm pace.

---

## The script

**Slide 1 — Title** *(0:00 · 6s)*
> Ninety seconds — weeks one and two of Charon. An efficient privacy protocol
> for a public chain.

**Slide 2 — "Solana is public."** *(0:06 · 9s)*
> The problem: Solana is public — every transfer sits on-chain forever. Your
> money shouldn't be. Charon leaves only commitments: no amount, no recipient.

**Slide 3 — "Heavy math, light footprint."** *(0:15 · 13s)*
> The protocol is deliberately lightweight. Proofs are generated on your own
> device, and the on-chain program is 65 kilobytes. Your balance lives in
> state-of-the-art encrypted notes, scanned locally — to everyone else, just
> commitments.

**Slide 4 — "The stack is live." — THE UPDATES, slow down here** *(0:28 · 18s)*
> The updates. Week one: SPL transfers, so you can shield any token; smaller
> encrypted outputs; and CI gates across program, model and circuit. Week two:
> the backend rebuilt around notes, app v2 merged, everything unified on one
> integration branch. The protocol part — complete.

**Slide 5 — The flow** *(0:46 · 4s — a flash, don't linger)*
> And this loop ran live, end to end — deposit, proof, relay, settle.

**Slide 6 — "Shielded, and fast." — the bench** *(0:50 · 19s)*
> The bench: twelve transfers in thirty seconds wall-clock — about two and a
> half seconds each, two of those the Groth16 proof on-device. 137,000 compute
> units per transfer, a 1,066-byte transaction, a 65-kilobyte program, zero
> failures. One of the most efficient private-transfer designs on Solana.

**Slide 7 — Closing** *(1:09 · 5s)*
> Next week: a full-fledged devnet launch. Thank you.

**Done at ~1:14.** If you're running long, compress slide 3 to "Proofs on your
device, a 65-kilobyte program, encrypted notes — that's the whole protocol."

---

## Delivery notes

- The **only** slide that deserves slow-down is **slide 4** (the updates) —
  that's what the meeting is for. Slides 1–3 are setup; 5 is a flash; 6 is the
  flex; 7 is the hook for next week.
- The slide 7 line ("full-fledged devnet launch") is on-screen now — land it
  and stop talking.
- If asked to prove "ran live": the loop was exercised end to end on a fresh
  chain — deposit signature, note scan, withdraw with a client-side proof,
  settled.

---

## Q&A ammo (if they poke)

**What do the bench numbers mean?**
- **29.95 s wall** — yes, it's the *total* wall-clock for the whole 12-transfer
  test run: the timer starts before transfer #1 and stops after #12 settles.
  Per transfer that's 2.48 s.
- **Why 12 and not 1?** One run is an anecdote; N runs are a measurement.
  Proving time jitters ±100–200 ms run to run, so a single transfer could get
  lucky. Twelve loops through the real SDK (fetch → build → prove → sign →
  land) make the average trustworthy — and "0 failures" a claim about
  reliability, not luck. There's no fixed industry number like "12"; the
  standard *practice* in ZK/DeFi benchmarking is to report the mean/median
  over N runs. Twelve is simply the sample that stabilizes the average and
  runs on a laptop in half a minute.
- **12 transfers** — twelve *complete* deposit→withdraw loops through the real
  SDK, not microbenchmarks.
- **2.48 s / 2.02 s proof** — the loop is proof-dominated: ~2.0 s Groth16
  on-device, ~0.3 s chain.
- **136.7k CU** — proof verification + tree update; ceiling is 1.4M → ~10×
  headroom.
- **1,066 B tx** — fits the legacy 1,232-byte packet cap; works from any wallet.
- **65 KB program** — the entire ZK engine on-chain (vs 200 KB–1 MB typical);
  0.47 SOL rent.
- **0 failures** — all twelve landed first try.

**"2.5 s is slow for Solana?"** → The chain costs ~0.3 s; 2.0 s is the Groth16
proof, single-threaded in the browser. Our Rust prover already proves the same
circuit in 0.28 s in-process — that swap is exactly next week's work. That's
why slide 7 exists.

**"Faster finality (new consensus) — does it help?"** → Pure upside, zero
protocol changes. We wait for full finality per transfer (~13 s on mainnet
today); instant-finality consensus collapses it to ~150 ms, making the proof
the only wait. Our bench already measures on instant-finality chains, so these
numbers are that future.

**"Payroll?"** → Modest speedup from finality; the real ceiling was
proof-building throughput — batching + client-built proofs break that, already
prototyped (210 payouts ≈ 13 s with the batch circuit).

**"What's on-chain?"** → One fixed 4,080-byte tree account (78% is the
100-root history), 40 B config, 33 B token authority, 1 B nullifier per spend.
State never grows — 1 deposit and 67M cost the same bytes.

---

## Appendix — longer cuts

### A. With the live app demo (deck → app → deck, ~3.5 min)
Run slides 1–4 as above, then instead of flashing slide 5, go live: connect
wallet (one signature registers the viewing key) → deposit 0.01 SOL ("the
chain records only two commitments") → Load notes ("my balance is an encrypted
note only I can decrypt") → withdraw to a fresh address ("the browser proves
in two seconds — nothing links back to my deposit") → deck slide 6 bench close.

### B. Full presentation (~4 min)
Use the deck's N-key notes from the previous version, or speak slides 2–5 with
the Q&A context above woven in.

---

*Stack behind the numbers: surfpool (instant finality) · program `3X8Xfo…`
(65 KB on-chain) · local indexer :8080 · app :5173. Values verified against
the live chain 2026-09-28.*
