# Frontend revamp + flow.html — design

Date: 2026-07-25
Status: Approved (design dialogue complete)

## Goal

Revamp the `frontend/` React app into a professional, fully-fledged-SaaS-looking
product (the current dark "glassmorphism cyber" theme reads as AI slop and is
internally inconsistent), and ship a new standalone `flow.html` that documents
every user action flow end-to-end with accurate, interactive diagrams.

Two deliverables share one visual language: the look already proven in
`presentation.html`.

## Non-goals (out of scope)

- No new runtime dependencies. No router library (keep hash routing).
- No changes to the backend, the Rust SDK, the on-chain program, or
  `presentation.html` (read-only style source).
- No relayer submit path in the web client (the existing read-only backend
  relayer route stays as-is; we just stop marketing it as a user feature).

## Decisions (locked in dialogue)

1. **Visual direction:** light editorial, matching `presentation.html`.
   - Space Grotesk (display), IBM Plex Sans (body), IBM Plex Mono (labels/code).
   - Paper `#ffffff`, panels `#f5f6f8`/`#eef0f4`, ink `#0e1116`, body `#3f4757`,
     mute `#868f9e`, lines `#e4e7ec`/`#d4d8e0`, accent violet `#5b54e6` / soft `#ecebfc`.
   - Role colors: program `#111827`, indexer/backend `#0e7c86`, wallet `#5b54e6`,
     sdk `#b45309`, data `#424a57`.
   - Radius 14px, subtle shadows, no neon glows, no gradient text.
2. **Relayer narrative:** tell the truth — client SDK self-signs and submits
   BOTH deposit and withdraw directly to RPC; the backend is read-only. Strip
   every "gasless / relayer pays gas" claim. Health badge reads "Backend
   Online/Offline".
3. **Routing:** section routes + in-app tabs. `/` landing, `/app` (SOL/SPL ×
   Deposit/Withdraw tabs), `/vault`, `/explorer`, `/admin`. The `/flow` route
   and `FlowView.tsx` are removed.
4. **flow.html format:** interactive step-through (click / ←→ through numbered
   steps per flow), standalone HTML, same light editorial CSS.

## Architecture / facts (verified in code)

- Web client withdraw path (the one users click): `WithdrawCard` →
  `client.withdrawSOL()` (`@privacy-cash/client`) → wallet `signTransaction` →
  `connection.sendRawTransaction(signed.serialize())` direct to RPC
  (`sdk/src/client.ts:782`). Deposit is analogous. **No relayer in the live path.**
- `api.withdraw` → `POST /api/relayer` is dead code (no caller in `frontend/src`).
- Backend is read-only: `/health`, `/indexer/status`, `/api/merkle/.../proof`,
  roots, `/api/nullifier/...`, `/api/utxos/...`, `/api/relayer/info` (fees).
- SDK public methods traced for flow.html: `unlock` (132), `syncNotes` (161),
  `depositSOL` (220), `withdrawSOL` (289), `depositSPL` (304), `withdrawSPL` (399),
  `withdrawInternal` (458), `proveAndSend` (641).

## Deliverable A — React app revamp

### A.1 Design system (`frontend/src/index.css`)
- Redefine Tailwind v4 `@theme` / `:root` tokens to the light-editorial values so
  existing shadcn primitives (`bg-background`, `text-foreground`, `--primary`,
  `--border`, …) resolve light.
- Add Google Fonts (Space Grotesk, IBM Plex Sans, IBM Plex Mono).
- Port editorial utility classes from `presentation.html`: `.eyebrow`, `.chip`
  (+ role variants), `.card`, `.steps`, `.h1/.h2/.h3`, `.mono`, `.tag` (pub/priv).
- Remove `glass-panel`, `glass-panel-glow`, `glow-*`, `gradient-text`,
  `gradient-border`, radial-gradient body bg.

### A.2 Shell & routing (`App.tsx`, `NavBar.tsx`)
- Remove `flow` from the route list, footer links, and imports; delete
  `FlowView.tsx`.
- Light sticky NavBar: editorial brand mark (the SVG Merkle-tree logo from
  `presentation.html`), nav pills, wallet button. Relabel health badge to
  "Backend Online/Offline" (still pings `/health`).

### A.3 Pages
- **Landing (`LandingHero.tsx`):** SaaS hero — headline + subhead + "Launch App"
  + "View Explorer" CTAs, the Merkle-tree hero SVG, a stats strip, three accurate
  feature cards. Copy de-slopped (see §A.5). Remove the dead "Interactive Flow"
  button and "Architecture Highlights" relayer claims.
- **App (`UserAppView.tsx` + `DepositCard` / `DepositSplCard` / `WithdrawCard` /
  `WithdrawSplCard`):** keep SOL/SPL toggle + Deposit/Withdraw tabs. Restyle all
  cards. Drop the "Relayed" badge on the withdraw tab.
- **Vault (`VaultView.tsx` + `NotesCard`/`MerkleTreeCard`/…):** restyle.
- **Explorer (`ExplorerView.tsx` + `NullifierCard`/…):** restyle.
- **Admin (`AdminView.tsx` + `AdminCard`/`RelayerInfoCard`/…):** restyle.
- Sweep every `slate-*`, glow, and `gradient-text` class out of all components.

### A.4 shadcn primitives (`components/ui/*`)
- Update default variants to the new tokens (e.g. primary button = violet
  `#5b54e6`, ink text, paper card). Keep APIs unchanged.

### A.5 Accuracy cleanup (de-slop copy)
- `NavBar`: "Relayer Online/Offline" → "Backend Online/Offline".
- `LandingHero`: "Gasless Relayed Payouts / Relayer pays network gas" →
  "Self-signed, direct to RPC — the pool pays the recipient and the fee."
- `UserAppView`: remove the "Relayed" badge on the Withdraw tab.
- `FlowView`: deleted.
- Cards: keep `WithdrawCard`'s existing "no relayer involved" copy; fix any
  relayer wording in the others.

## Deliverable B — `flow.html` (root)

Standalone interactive step-through, styled identically to `presentation.html`.

- **Flow switcher:** Deposit SOL · Deposit SPL · Withdraw SOL · Withdraw SPL ·
  Scan Notes · Admin.
- **Per flow:** a horizontal pipeline diagram (SDK → Wallet → RPC → Program →
  Indexer) with the active stage highlighted; a numbered, clickable step list;
  per-step detail (actor, what happens, real code snippet from
  `sdk/src/client.ts`); prev/next + keyboard ←/→, dots, hash deep-link,
  reduced-motion respected.
- Each flow runs from "user clicks the action" through wallet sign, RPC submit,
  on-chain confirmation, to the indexer recording the leaf/nullifier.
- Accurate: client-side direct-to-RPC, no relayer. Steps derived from the real
  SDK methods listed above.

## Phasing

1. **flow.html** — self-contained, zero build risk. Ship first.
2. **React revamp** — tokens/fonts → shell+nav → landing → app+cards →
   vault/explorer/admin → delete flow route. Run `tsc -b` + `vite build` after
   each layer; fix issues before continuing. No "it works" claims without a
   passing build.

## Risks / notes

- `lucide-react@1.24.0` is a very old major; keep current icon usage, add new
  icons only if already imported elsewhere (verify before use).
- Tailwind v4 theming via `@theme` — verify token names the shadcn primitives
  expect (`--background`, `--foreground`, `--primary`, `--border`, `--ring`).
- Don't touch `backend/` or `sdk/` behavior; only read `sdk/src/client.ts` for
  flow.html accuracy.
