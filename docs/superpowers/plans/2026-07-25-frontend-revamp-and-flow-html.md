# Frontend revamp + flow.html — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `frontend/` React app into a light-editorial, fully-fledged-SaaS product (matching `presentation.html`), remove the inaccurate Architecture/flow tab and all stale "gasless relayer" claims, and ship a standalone interactive `flow.html` documenting every user action end-to-end.

**Architecture:** Single deliverable B (`flow.html`) is a self-contained vanilla HTML/CSS/JS file styled identically to `presentation.html`. Deliverable A re-themes the React app by swapping the Tailwind v4 design tokens in `index.css` (adding the missing `@theme inline` block so shadcn semantic utilities resolve), then sweeping components off dark `slate-*`/glow classes onto the new tokens + editorial utility classes. Routing stays hash-based; the `/flow` route is deleted.

**Tech Stack:** React 19, Tailwind CSS v4 (`@tailwindcss/vite`, config in CSS), shadcn-style primitives (cva + Radix Slot), lucide-react@1.24.0, Google Fonts (Space Grotesk + IBM Plex Sans + IBM Plex Mono).

## Global Constraints

- **Fonts:** Space Grotesk (display), IBM Plex Sans (body), IBM Plex Mono (labels/code) — loaded via Google Fonts `<link>` (flow.html) and `@import url(...)` in `index.css` (React).
- **Light-editorial palette (exact):** paper `#ffffff`; panel `#f5f6f8`; panel-2 `#eef0f4`; line `#e4e7ec`; line-2 `#d4d8e0`; ink `#0e1116`; body `#3f4757`; mute `#868f9e`; accent `#5b54e6`; accent-soft `#ecebfc`. Role colors: program `#111827`, indexer/backend `#0e7c86`, wallet `#5b54e6`, sdk `#b45309`, data `#424a57`.
- **Radius:** 14px. Shadows subtle only — no neon glows, no `gradient-text`.
- **Accuracy rule:** no user-facing mention of "gasless", "relayer pays gas", or a relayer in the deposit/withdraw submit path. Health badge text = "Backend Online/Offline". (The operator Admin actions legitimately use backend `/api/relayer/*` operator endpoints — those stay, clearly labeled "Operator".)
- **Icons:** `lucide-react@1.24.0`. Only use icons already imported somewhere in `frontend/src`; do not assume new icon names exist. Verify with `grep` before adding.
- **Build gate:** after every React task, run `cd frontend && npm run build` (= `tsc -b && vite build`) and ensure it passes with zero errors before committing. `node_modules` is present.
- **Don't touch:** `backend/`, `sdk/`, `presentation.html` (read-only style source), any relayer/db code.
- **Commits:** one commit per task, scoped to that task's files. Do not commit unrelated WIP.

## File Structure

**flow.html** (create, repo root, sibling of `presentation.html`) — standalone interactive step-through.
**frontend/src/index.css** (rewrite) — Tailwind v4 tokens + `@theme inline` + fonts + editorial utilities.
**frontend/src/components/ui/{button,card,badge,input,label,alert,textarea,sonner}.tsx** (modify) — rely on new tokens; minimal edits.
**frontend/src/App.tsx** (modify) — drop `flow` route + footer link + FlowView import.
**frontend/src/components/NavBar.tsx** (rewrite) — light shell, brand SVG, "Backend Online/Offline".
**frontend/src/components/FlowView.tsx** (delete).
**frontend/src/components/LandingHero.tsx** (rewrite) — SaaS landing, de-slopped copy.
**frontend/src/components/UserAppView.tsx** + `DepositCard`, `DepositSplCard`, `WithdrawCard`, `WithdrawSplCard` (modify) — restyle, remove "Relayed" badge.
**frontend/src/components/{VaultView,ExplorerView,AdminView}.tsx** + their sub-cards (modify) — restyle.

---

## Phase 1 — flow.html (zero build risk; ship first)

### Task 1: Scaffold interactive flow.html with one flow wired

**Files:**
- Create: `flow.html` (repo root)

**Interfaces:**
- Produces: a standalone HTML page with the editorial CSS (ported from `presentation.html` `:root` + component classes), a flow switcher, a step rail, prev/next + keyboard nav, hash deep-link, reduced-motion. Deposit SOL flow fully populated; remaining flows added in Task 2.

- [ ] **Step 1: Create `flow.html`** with this exact structure. Port the `<style>` block verbatim from `presentation.html` (`:root` tokens, `.eyebrow`, `.chip` + role variants, `.card`, `.steps`, `.flow`/`.fnode`/`.farrow`, `.tag`, `.tbl`, `.legend`, nav chrome). Then add the interactive shell below. The CSS variables to use (already in the ported `:root`): `--paper #fff`, `--panel #f5f6f8`, `--ink #0e1116`, `--body #3f4757`, `--mute #868f9e`, `--accent #5b54e6`, role colors as listed in Global Constraints.

HTML body skeleton:

```html
<header class="brand"><!-- ported brand SVG + "Privacy Cash · flows" --></header>
<nav class="flowswitch" id="flowswitch">
  <button data-flow="deposit-sol" class="on">Deposit SOL</button>
  <button data-flow="deposit-spl">Deposit SPL</button>
  <button data-flow="withdraw-sol">Withdraw SOL</button>
  <button data-flow="withdraw-spl">Withdraw SPL</button>
  <button data-flow="scan">Scan notes</button>
  <button data-flow="admin">Admin (operator)</button>
</nav>

<main id="flow" class="flowdoc">
  <div class="flowdoc__head">
    <p class="eyebrow" id="f-eyebrow"></p>
    <h2 class="h2" id="f-title"></h2>
    <p class="lead" id="f-lead"></p>
    <!-- pipeline diagram: 5 stages, active stage highlighted -->
    <div class="flow" id="f-pipeline"></div>
  </div>

  <div class="flowdoc__body grid-2">
    <ol class="steps" id="f-steps"></ol>
    <div class="col">
      <div class="card" id="f-detail"><h4 id="f-actor"></h4><p id="f-summary"></p></div>
      <pre class="code" id="f-code"></pre>
    </div>
  </div>
</main>

<nav class="nav" id="nav">
  <button id="prev">‹</button>
  <div class="dots" id="dots"></div>
  <button id="next">›</button>
</nav>
<div class="counter" id="counter"><b id="cur">1</b> / <span id="tot"></span></div>
```

JS: a `FLOWS` object keyed by flow id; each entry has `{ eyebrow, title, lead, stages:[{label,role}], steps:[{actor,role,summary,code}] }`. `render(flowId, stepIdx)` updates title/lead, builds `.flow` pipeline nodes (marking the active stage by step→stage mapping), the `.steps` list (clicking a step sets `stepIdx`), the detail card, and the code block. Wire switcher buttons, prev/next, keyboard ←/→, dots, and `location.hash` deep-link `#<flowId>-<n>`.

Populate **Deposit SOL** (`deposit-sol`) now:
- `stages`: pcash (sdk) → Wallet → RPC → Program → Indexer
- `steps` (exact, from `sdk/src/client.ts depositSOL` + presentation.html deposit flow):
  1. actor `Client SDK`, summary "Wallet signs the note-derive message; SDK derives the shielded spending key.", code `await client.unlock() // signer.signMessage(...)`
  2. actor `Client SDK`, summary "Generate a random blinding factor and compute the commitment Poseidon(amount, pubkey, blinding, mint); encrypt the output note locally.", code `note = makeNote({amount, mint, ...}); commitment = poseidon(...)`
  3. actor `Client SDK · WASM`, summary "Build a Groth16 proof with ext_amount > 0 — this is a deposit.", code `proof = await groth16.prove({ext_amount: +lamports, ...})`
  4. actor `Wallet`, summary "Build the Transact instruction and sign the versioned transaction.", code `const tx = buildTransact(proof, extData); signed = await signer.signTransaction(tx)`
  5. actor `Solana RPC`, summary "SDK submits the signed tx direct to RPC (no relayer) and confirms.", code `sig = await conn.sendRawTransaction(signed.serialize(), {maxRetries:5})`
  6. actor `Program · Pinocchio`, summary "Verify the proof, append the commitment as a new leaf in the height-26 tree, init the nullifier, emit the leaf-index event.", code `verify_groth16(...)?; tree.insert(commitment)?; emit!(LeafIndex{...})`
  7. actor `Backend indexer`, summary "Decode the event; write leaf + nullifier to Postgres. Client saves the encrypted note locally.", code `indexer.record(leaf, nullifier); saveNote(...)`

- [ ] **Step 2: Open `flow.html` in a browser** (or `open flow.html` on macOS). Verify: the editorial light theme renders, the Deposit SOL pipeline shows 5 stages, clicking steps and prev/next advances and highlights the active stage, ←/→ keys work, the URL hash deep-links.

- [ ] **Step 3: Commit**
```bash
git add flow.html
git commit -m "docs: add interactive flow.html with deposit-SOL flow"
```

### Task 2: Populate the remaining five flows accurately

**Files:**
- Modify: `flow.html` (extend the `FLOWS` object)

**Interfaces:** Consumes the `FLOWS` shape from Task 1. Produces complete, accurate step data for all six flows.

- [ ] **Step 1: Add the five remaining flows** to `FLOWS`, each `stages` = pcash → Wallet → RPC → Program → Indexer (Scan uses pcash → Backend → local; Admin uses Operator → Backend → Program). Exact step content:

**Deposit SPL** (`deposit-spl`, `TransactSpl`): same as Deposit SOL but — step 4 builds `TransactSpl`; step 6 verifies against the per-mint tree account; add an ATA note ("recipient / vault ATAs ensured"). code snippets reference `depositSPL(mint, amount)`.

**Withdraw SOL** (`withdraw-sol`, `withdrawSOL`→`withdrawInternal`→`proveAndSend`, ext_amount < 0):
1. Client SDK — "Wallet signs the note-derive message; derive spending key." `await client.unlock()`
2. Client SDK — "Fetch the Merkle path + a known root from the read-only backend." `const path = await api.merkleProof(treeKey, leafIndex)`
3. Client SDK · WASM — "Build a Groth16 withdraw proof (ext_amount < 0), bound to recipient + fee." `proof = await groth16.prove({ext_amount:-lamports, recipient, fee, root, path})`
4. Wallet — "Build the Transact ix (pool pays recipient + fee); sign the versioned tx." `tx = buildTransact(proof, extData); signed = await signer.signTransaction(tx)`
5. Solana RPC — "SDK submits direct to RPC (no relayer) and confirms." `sig = await conn.sendRawTransaction(signed.serialize())`
6. Program · Pinocchio — "Verify the proof, check the nullifier is unspent, create the nullifier PDA, pay recipient + fee." `verify_groth16(...)?; ensure_nullifier_unused?; create_nullifier_pda?; vault.pay(recipient, fee)?`
7. Backend indexer — "Record the nullifier; client marks the note spent locally." `indexer.record(nullifier); markNoteSpent(...)`

**Withdraw SPL** (`withdraw-spl`, `TransactSpl`): same as Withdraw SOL but SPL — step 4 builds `TransactSpl` with idempotent recipient + fee-recipient ATA creation; step 6 pays SPL tokens. code references `withdrawSPL(...)`.

**Scan notes** (`scan`, `syncNotes`): `stages` = Client → Backend (read) → Client (local).
1. Client SDK — "Download the next leaf range from the read-only backend." `const page = await api.utxoRange(treeKey, offset, offset+SIZE)`
2. Backend — "Returns encrypted outputs only; it never knows which are yours (no 'notes by address' endpoint)."
3. Client SDK — "Decrypt each encrypted output locally with the derived key; keep those you own." `for (e of page) { n = decrypt(e, key); if (owns(n)) saveNote(n) }`
4. Client SDK — "Advance the sync offset; spent notes are marked." `setSyncOffset(treeKey, page.end)`

**Admin** (`admin`, operator): `stages` = Operator → Backend → Program. `eyebrow` "Operator only". Steps: initialize (boot SOL pool/vault/tree/config via `/api/relayer/initialize`); initialize-spl (per-mint tree); update-config (fee rates); update-deposit-limit / -spl. Each step's summary names the route + instruction (`Initialize`, `InitializeTreeAccountForSplToken`, `UpdateGlobalConfig`, `UpdateDepositLimit`, `UpdateDepositLimitForSpl`).

- [ ] **Step 2: Reload `flow.html`** and click through all six flows. Verify: every flow renders with the correct pipeline, steps are accurate (no relayer in deposit/withdraw), code snippets show.

- [ ] **Step 3: Commit**
```bash
git add flow.html
git commit -m "docs(flow.html): add deposit-spl, withdraw, scan, admin flows"
```

---

## Phase 2 — React app re-theme

### Task 3: Rewrite `index.css` design tokens + fonts + editorial utilities

**Files:**
- Modify: `frontend/src/index.css` (full rewrite)

**Interfaces:** Produces the design tokens all components depend on: `--background/--foreground/--card/--primary/--border/...` light values, an `@theme inline` block mapping `--color-*` → those vars (so shadcn utilities resolve), the three fonts, and editorial utility classes (`.eyebrow`, `.chip` + role variants, `.mono`, `.tag`).

- [ ] **Step 1: Replace the entire contents of `frontend/src/index.css`** with:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap");

@custom-variant dark (&:is(.dark *));

:root {
  --radius: 0.875rem;

  /* light-editorial palette */
  --paper: #ffffff;
  --panel: #f5f6f8;
  --panel-2: #eef0f4;
  --line: #e4e7ec;
  --line-2: #d4d8e0;
  --ink: #0e1116;
  --body-ink: #3f4757;
  --mute: #868f9e;
  --accent: #5b54e6;
  --accent-soft: #ecebfc;

  /* shadcn semantic tokens (light) */
  --background: #ffffff;
  --foreground: #0e1116;
  --card: #ffffff;
  --card-foreground: #0e1116;
  --popover: #ffffff;
  --popover-foreground: #0e1116;
  --primary: #5b54e6;
  --primary-foreground: #ffffff;
  --secondary: #eef0f4;
  --secondary-foreground: #0e1116;
  --muted: #f5f6f8;
  --muted-foreground: #868f9e;
  --accent: #5b54e6;
  --accent-foreground: #ffffff;
  --destructive: #dc2626;
  --border: #e4e7ec;
  --input: #e4e7ec;
  --ring: #5b54e6;
}

/* map semantic tokens to Tailwind v4 color utilities so bg-primary / bg-card / text-muted-foreground resolve */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
  --font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
}

body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  min-height: 100vh;
}

/* editorial utility classes (ported from presentation.html) */
.eyebrow {
  font-family: var(--font-mono); font-size: .74rem; letter-spacing: .14em;
  text-transform: uppercase; color: var(--mute);
  display: inline-flex; align-items: center; gap: .6em; margin: 0 0 1rem;
}
.eyebrow::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--accent); }

.chip {
  display: inline-flex; align-items: center; gap: .5em;
  font-family: var(--font-mono); font-size: .72rem; letter-spacing: .05em;
  text-transform: uppercase; color: var(--body-ink);
  background: var(--panel); border: 1px solid var(--line);
  padding: .4em .8em; border-radius: 999px; white-space: nowrap;
}
.chip::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--cc, var(--accent)); }
.chip--program { --cc: #111827; }
.chip--indexer { --cc: #0e7c86; }
.chip--wallet  { --cc: #5b54e6; }
.chip--sdk     { --cc: #b45309; }
.chip--data    { --cc: #424a57; }

.mono { font-family: var(--font-mono); }
.accent { color: var(--accent); }
.h-display { font-family: var(--font-display); font-weight: 700; letter-spacing: -.02em; }

.tag { display: inline-flex; align-items: center; gap: .4em; font-family: var(--font-mono); font-size: .72rem;
       padding: .28em .6em; border-radius: 7px; border: 1px solid var(--line); }
.tag--pub  { border-color: #c9c5fb; color: var(--accent); background: var(--accent-soft); }
.tag--priv { border-style: dashed; border-color: var(--line-2); color: var(--mute); background: transparent; }

/* scrollbars */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--panel); }
::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background: var(--mute); }
```

- [ ] **Step 2: Build**
Run: `cd frontend && npm run build`
Expected: PASS (the app will look broken/mixed until components are swept in later tasks — that is expected; only confirm it compiles).

- [ ] **Step 3: Commit**
```bash
git add frontend/src/index.css
git commit -m "feat(frontend): light-editorial design tokens, fonts, @theme mapping"
```

### Task 4: Verify shadcn primitives resolve on new tokens

**Files:**
- Read-only check: `frontend/src/components/ui/{button,card,badge,input,label,alert,textarea,sonner}.tsx`

- [ ] **Step 1: Confirm primitives need no edits.** They already use semantic utilities (`bg-primary`, `bg-card`, `text-muted-foreground`, `border-input`, `bg-destructive`) which now resolve via the `@theme inline` block from Task 3. Do not change their APIs. If `badge.tsx` or `sonner.tsx` hard-codes a dark color, adjust only that literal to a token (e.g. `bg-primary`).

- [ ] **Step 2: Build**
Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit only if any literal was changed** (otherwise skip — no commit for a read-only task).

### Task 5: App shell — NavBar rewrite, drop flow route, delete FlowView

**Files:**
- Modify: `frontend/src/components/NavBar.tsx` (rewrite)
- Modify: `frontend/src/App.tsx` (remove `flow` route, footer link, FlowView import)
- Delete: `frontend/src/components/FlowView.tsx`

**Interfaces:**
- Consumes: tokens from Task 3.
- Produces: `NavBar` still exports `NavBar({currentRoute,onNavigate})`; `App` no longer references `flow`.

- [ ] **Step 1: Rewrite `NavBar.tsx`.** Light sticky header: paper background with a `border-b border-[var(--line)]`; brand block = the Merkle-tree SVG (copy the `<svg>` from `presentation.html` brand, stroke `#5b54e6`) + "PRIVACY CASH" wordmark (`font-display`) + "Solana ZK-SNARK Protocol" subline (`text-muted-foreground text-xs`). Nav pills styled with `bg-secondary` active / `text-muted-foreground` inactive (no emerald). Health badge: replace the "Relayer Online/Offline" strings with **"Backend Online"** / **"Backend Offline"** / **"Checking backend…"**; dot stays green/red/amber. Keep `WalletMultiButton`. Remove the `flow`/Architecture nav item entirely. Mobile row likewise drops it.

Exact text replacements in the file:
- `? "Relayer Online"` → `? "Backend Online"`
- `: health === "down"` branch label `"Relayer Offline"` → `"Backend Offline"`
- `"Checking Relayer…"` → `"Checking backend…"`
- Delete the `{ id: "flow", label: "Architecture", icon: Cpu }` nav item; remove `Cpu` from the lucide import if now unused.

- [ ] **Step 2: Edit `App.tsx`.** Remove `FlowView` import, remove `"flow"` from both route arrays and the `includes(...)` checks, remove `{route === "flow" && <FlowView />}`, and remove the footer "Architecture Flow" button.

- [ ] **Step 3: Delete `FlowView.tsx`**
Run: `git rm frontend/src/components/FlowView.tsx`

- [ ] **Step 4: Sweep NavBar/App off dark classes.** Replace `bg-slate-950`, `text-slate-100`, `border-slate-800`, `from-emerald-400 to-indigo-500`, `bg-slate-900/...` etc. with token utilities (`bg-background`, `text-foreground`, `border-border`, `bg-secondary`, `text-primary`). App root div: `className="min-h-screen bg-background text-foreground flex flex-col justify-between"`.

- [ ] **Step 5: Build + grep**
Run: `cd frontend && npm run build`
Expected: PASS.
Run: `grep -rn "flow\|FlowView\|Architecture" frontend/src/App.tsx frontend/src/components/NavBar.tsx`
Expected: no matches.

- [ ] **Step 6: Commit**
```bash
git add frontend/src/App.tsx frontend/src/components/NavBar.tsx
git commit -m "feat(frontend): light app shell, Backend health badge, drop flow route"
```

### Task 6: Landing page rewrite (`LandingHero.tsx`)

**Files:**
- Modify: `frontend/src/components/LandingHero.tsx` (rewrite body)

- [ ] **Step 1: Rewrite to a SaaS landing.** Sections:
  1. **Hero:** `eyebrow` "Zero-knowledge privacy pool on Solana"; `h-display` headline "Break the on-chain link." + accent line "Transact in complete silence."; lead paragraph (de-slopped): "Deposit SOL or SPL tokens, hold a secret note, and withdraw to a fresh address with a client-side ZK proof. Your wallet signs and submits direct to the chain — the pool pays the recipient and the fee." CTAs: "Launch App" (primary → `onNavigate("app")`) and "View Explorer" (outline → `onNavigate("explorer")`). **Remove** the "Interactive Flow" button entirely.
  2. **Merkle hero SVG:** paste the `<svg class="hero" viewBox="0 0 420 300">` Merkle-tree graphic from `presentation.html` (title slide) into the hero right column.
  3. **Stats strip** (4): Proof generation ~client-side Groth16; Merkle depth 26 (height-26 Poseidon tree); Supported assets SOL + SPL; Submit path "Self-signed, direct to RPC". Replace the old "Recipient Cost 0 SOL / Relayer pays network gas" stat.
  4. **Feature cards (3):** "100% client-side ZK" / "Direct-to-RPC withdrawals" (was "Gasless Relayed Payouts" — rewrite: "Your wallet signs and submits withdrawals directly. The pool pays the recipient and the protocol fee — no relayer in the path.") / "Double-spend proof" (on-chain nullifier set).
  5. **3-step preview:** Shield & deposit → Generate ZK proof → Withdraw to a fresh address.

Use editorial classes: cards as `bg-secondary border border-border rounded-[14px] p-6`; numbers as violet `text-primary font-mono`. Remove all `glass-panel`, `gradient-text`, emerald/indigo glows.

- [ ] **Step 2: Grep for banned terms in this file**
Run: `grep -n "glass-panel\|gradient-text\|gasless\|Relayer\|relayer\|emerald-\|indigo-\|slate-" frontend/src/components/LandingHero.tsx`
Expected: no matches.

- [ ] **Step 3: Build**
Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add frontend/src/components/LandingHero.tsx
git commit -m "feat(frontend): light-editorial landing page, de-slopped copy"
```

### Task 7: App view + deposit/withdraw cards restyle + remove "Relayed" badge

**Files:**
- Modify: `frontend/src/components/UserAppView.tsx`
- Modify: `frontend/src/components/DepositCard.tsx`, `DepositSplCard.tsx`, `WithdrawCard.tsx`, `WithdrawSplCard.tsx`

- [ ] **Step 1: `UserAppView.tsx`** — restyle header/tabs to tokens; **remove the `<Badge>Relayed</Badge>`** on the Withdraw tab and any relayer wording. SOL/SPL toggle pills use `bg-primary` active.

- [ ] **Step 2: The four cards** — replace `slate-*`/emerald/indigo classes with tokens; primary action buttons `bg-primary text-primary-foreground`. Keep logic and the existing "no relayer involved" copy in `WithdrawCard.tsx` (already correct). Fix any relayer wording found in `DepositCard`/`DepositSplCard`/`WithdrawSplCard`.

- [ ] **Step 3: Grep + build**
Run: `grep -rn "Relayed\|slate-\|emerald-\|indigo-\|glass-panel" frontend/src/components/UserAppView.tsx frontend/src/components/{Deposit,DepositSpl,Withdraw,WithdrawSpl}Card.tsx`
Expected: no `Relayed`, no `glass-panel`; residual palette only if intentional (aim for none).
Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add frontend/src/components/UserAppView.tsx frontend/src/components/DepositCard.tsx frontend/src/components/DepositSplCard.tsx frontend/src/components/WithdrawCard.tsx frontend/src/components/WithdrawSplCard.tsx
git commit -m "feat(frontend): restyle app view + cards, remove Relayed badge"
```

### Task 8: Vault, Explorer, Admin views + sub-cards restyle

**Files:**
- Modify: `frontend/src/components/VaultView.tsx`, `ExplorerView.tsx`, `AdminView.tsx`, and any sub-cards they render (`NotesCard`, `MerkleTreeCard`, `NullifierCard`, `RelayerInfoCard`, `AdminCard`, `ResponsePanel`).

- [ ] **Step 1: Restyle each view** to tokens/editorial classes (cards `bg-secondary border-border`, headings `font-display`, code blocks `bg-panel border-border font-mono`). Keep Admin clearly labeled "Operator" (it legitimately calls `/api/relayer/*` operator endpoints — that copy stays). Replace `slate-*`/emerald/indigo throughout.

- [ ] **Step 2: Grep + build**
Run: `grep -rn "slate-\|emerald-\|indigo-\|glass-panel\|gradient-text\|glow-" frontend/src/components/{Vault,Explorer,Admin}View.tsx frontend/src/components/{NotesCard,MerkleTreeCard,NullifierCard,RelayerInfoCard,AdminCard}.tsx 2>/dev/null`
Expected: no matches.
Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**
```bash
git add frontend/src/components/VaultView.tsx frontend/src/components/ExplorerView.tsx frontend/src/components/AdminView.tsx frontend/src/components/NotesCard.tsx frontend/src/components/MerkleTreeCard.tsx frontend/src/components/NullifierCard.tsx frontend/src/components/RelayerInfoCard.tsx frontend/src/components/AdminCard.tsx frontend/src/components/ResponsePanel.tsx
git commit -m "feat(frontend): restyle vault/explorer/admin views"
```

### Task 9: Final sweep + full clean build

**Files:**
- Whole `frontend/src`.

- [ ] **Step 1: Grep the entire src for banned patterns**
Run:
```bash
cd frontend && grep -rn "glass-panel\|gradient-text\|glow-emerald\|glow-indigo\|gradient-border\|animate-pulse-subtle\|Relayer Online\|Relayer Offline\|Gasless\|gasless\|Relayer pays\|<Badge>Relayed</Badge>\|bg-slate-\|text-slate-\|border-slate-\|from-emerald\|to-indigo\|bg-emerald-\|text-emerald-\|bg-indigo-\|text-indigo-" src
```
Expected: no matches. Fix any remaining occurrences (some `slate-*` may be legitimate in a chart/heatmap — confirm each is intentional before leaving it).

- [ ] **Step 2: Full build**
Run: `cd frontend && npm run build`
Expected: PASS with zero TypeScript errors.

- [ ] **Step 3: Smoke-test in dev**
Run: `cd frontend && npm run dev` (then open the printed URL). Click through `/`, `/app` (SOL/SPL × deposit/withdraw), `/vault`, `/explorer`, `/admin`. Confirm: light editorial theme everywhere, no "Relayer Online"/"Gasless" copy, no Architecture tab, cards legible. Stop the server.

- [ ] **Step 4: Commit any final fixes**
```bash
git add -A frontend/src
git commit -m "chore(frontend): final de-slop sweep, clean build"
```

---

## Definition of Done

- `flow.html` opens standalone, all six flows click through accurately (no relayer in deposit/withdraw).
- `frontend/` builds clean (`npm run build`); the app is light-editorial; no banned terms/classes remain.
- Architecture/flow tab and stale relayer marketing are gone; health badge says "Backend Online/Offline".
- `backend/`, `sdk/`, `presentation.html` untouched.
