# Private Payroll v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone web app in `payroll/` where a treasurer uploads a JSON/CSV payroll file, funds it from the shielded vault (one signature only for the shortfall), and pays every employee gaslessly through the existing relayer.

**Architecture:** New Vite + React + Tailwind app consuming the local `privacy-cash-sdk` via `file:../sdk` (read-only). Pure-TS libs (parse/fees/history/engine) are framework-free and unit-tested; the React layer only renders engine snapshots. Payouts are sequential relayed `withdrawSOL`/`withdrawSPL` calls — zero changes to any code outside `payroll/`.

**Tech Stack:** React 19, Vite 6, Tailwind 4, @solana/wallet-adapter, privacy-cash-sdk (local), vitest, bun.

**Spec:** `payroll/DESIGN.md` (read it first — it records every product decision and the v2 shielded roadmap).

## Global Constraints

- **All files created/modified live under `payroll/` only.** Reading other folders (copying assets out of `frontend/`) is allowed; writing anywhere else is forbidden.
- **Branch `payroll`; never `git push` anything.** Every commit adds only `payroll/` paths (`git add payroll`).
- `mobile/src/screens/SettingsScreen.tsx` and `mobile/src/store.ts` are dirty in the working tree from earlier work — never stage them.
- **No `Co-Authored-By` or any AI trailer in commit messages.** Plain conventional commits.
- Amounts: file carries human units; the employee must net exactly the file amount (company absorbs the relayer fee). SOL decimals = 9.
- Commit after every task; run `bun run test` (vitest) and keep it green.
- Working directory for every command: `payroll/`.

---

### Task 1: Scaffold the app

**Files:**
- Create: `payroll/package.json`, `payroll/vite.config.ts`, `payroll/tsconfig.json`, `payroll/index.html`, `payroll/scripts/setup-native-deps.mjs`, `payroll/src/main.tsx`, `payroll/src/App.tsx`, `payroll/src/index.css`, `payroll/src/vite-env.d.ts`
- Copy: `frontend/src/index.css` → `payroll/src/index.css`; `frontend/src/components/ui/*` → `payroll/src/components/ui/*`; `frontend/src/snarkjs-shims.d.ts` → `payroll/src/snarkjs-shims.d.ts`; `frontend/public/circuit/*` and `frontend/public/favicon.svg` → `payroll/public/`

**Interfaces:**
- Produces: a bootable app on port 5174 that later tasks fill in.

- [ ] **Step 1: Create `package.json`** (dependency set mirrors the proven `frontend/` set; SDK linked to the local folder — this is what keeps everything inside `payroll/`):

```json
{
  "name": "payroll",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "postinstall": "node scripts/setup-native-deps.mjs"
  },
  "dependencies": {
    "@ethersproject/keccak256": "^5.8.0",
    "@ethersproject/sha2": "^5.8.0",
    "@lightprotocol/hasher.rs": "^0.2.1",
    "@radix-ui/react-label": "^2.1.11",
    "@radix-ui/react-slot": "^1.1.11",
    "@solana/spl-token": "^0.4.15",
    "@solana/wallet-adapter-base": "^0.9.27",
    "@solana/wallet-adapter-react": "^0.15.39",
    "@solana/wallet-adapter-react-ui": "^0.9.39",
    "@solana/wallet-adapter-wallets": "^0.19.38",
    "@solana/web3.js": "^1.98.4",
    "bn.js": "^5.2.5",
    "borsh": "^2.0.0",
    "bs58": "^6.0.0",
    "buffer": "^6.0.3",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "ethers": "^6.17.0",
    "ffjavascript": "^0.3.1",
    "lucide-react": "^1.24.0",
    "privacy-cash-sdk": "file:../sdk",
    "process": "^0.11.10",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "snarkjs": "^0.7.6",
    "sonner": "^2.0.7",
    "tailwind-merge": "^3.6.0",
    "tweetnacl": "^1.0.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.3.3",
    "@types/bn.js": "^5.2.0",
    "@types/node": "^24.13.2",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^4.7.0",
    "tailwindcss": "^4.3.3",
    "tw-animate-css": "^1.4.0",
    "typescript": "~6.0.2",
    "vite": "^6.3.5",
    "vite-plugin-node-polyfills": "^0.28.0",
    "vitest": "^3.2.4"
  }
}
```

- [ ] **Step 2: Create `vite.config.ts`** (frontend's polyfill setup verbatim — the SDK needs it in the browser; port 5174 so it can run beside the frontend):

```ts
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const polyfillsRoot = dirname(dirname(require.resolve("vite-plugin-node-polyfills")))
const shim = (name: string) => join(polyfillsRoot, "shims", name, "dist", "index.js")

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ["buffer", "process", "stream", "util", "assert", "path", "crypto"],
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      buffer: require.resolve("buffer/"),
      process: require.resolve("process/browser.js"),
      "vite-plugin-node-polyfills/shims/buffer": shim("buffer"),
      "vite-plugin-node-polyfills/shims/process": shim("process"),
      "vite-plugin-node-polyfills/shims/global": shim("global"),
    },
  },
  define: { global: "globalThis" },
  optimizeDeps: {
    include: [
      "buffer",
      "process",
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/process",
      "vite-plugin-node-polyfills/shims/global",
    ],
    esbuildOptions: { define: { global: "globalThis" } },
  },
  build: { commonjsOptions: { transformMixedEsModules: true } },
  server: { host: "0.0.0.0", port: 5174, fs: { allow: [".."] } },
})
```

- [ ] **Step 3: Create `tsconfig.json`**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client", "node"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "scripts"]
}
```

- [ ] **Step 4: Create `index.html`**:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy Payroll</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `scripts/setup-native-deps.mjs`** (frontend's script adapted: hasher wasm fix + circuit copied from `frontend/public/circuit` instead of an external clone):

```js
// Reproduces native artifacts the client SDK needs at runtime:
//   1. @lightprotocol/hasher.rs browser wasm (referenced from dist/browser-fat/es/)
//   2. the circom transaction2.{wasm,zkey} circuit (copied from ../frontend/public/circuit)
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

const hasherDist = [
  "node_modules/@lightprotocol/hasher.rs/dist",
  "../node_modules/@lightprotocol/hasher.rs/dist",
].find((p) => existsSync(path.join(p, "light_wasm_hasher_bg.wasm")))
if (hasherDist) {
  for (const [src, dst] of [
    ["light_wasm_hasher_bg.wasm", "browser-fat/es/light_wasm_hasher_bg.wasm"],
    ["hasher_wasm_simd_bg.wasm", "browser-fat/es/hasher_wasm_simd_bg.wasm"],
  ]) {
    const from = path.join(hasherDist, src)
    if (existsSync(from)) {
      copyFileSync(from, path.join(hasherDist, dst))
      console.log(`[setup] copied ${src} -> browser-fat/es/`)
    }
  }
}

const circuitSrc = path.join("..", "frontend", "public", "circuit")
const publicCircuit = path.join("public", "circuit")
if (existsSync(circuitSrc)) {
  mkdirSync(publicCircuit, { recursive: true })
  for (const f of ["transaction2.wasm", "transaction2.zkey"]) {
    copyFileSync(path.join(circuitSrc, f), path.join(publicCircuit, f))
    console.log(`[setup] copied ${f}`)
  }
} else {
  console.warn("[setup] ../frontend/public/circuit not found — skipping circuit copy.")
}
```

- [ ] **Step 6: Copy static pieces** (reads outside, writes inside — allowed):

```bash
mkdir -p src/components/ui public/circuit
cp ../frontend/src/index.css src/index.css
cp ../frontend/src/snarkjs-shims.d.ts src/snarkjs-shims.d.ts
cp ../frontend/src/components/ui/*.tsx src/components/ui/
cp ../frontend/public/circuit/transaction2.wasm public/circuit/
cp ../frontend/public/circuit/transaction2.zkey public/circuit/
cp ../frontend/public/favicon.svg public/
printf '/// <reference types="vite/client" />\n' > src/vite-env.d.ts
```

- [ ] **Step 7: Create `src/main.tsx`** (placeholder providers; real ones arrive in Task 7):

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 8: Create `src/App.tsx`** (placeholder):

```tsx
export default function App() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Privacy Payroll</h1>
      <p className="text-muted-foreground">Scaffold OK</p>
    </main>
  )
}
```

- [ ] **Step 9: Install and verify boot + build**

```bash
bun install
bun run build
bun run dev &   # then open http://localhost:5174 — expect "Privacy Payroll / Scaffold OK"; kill after
```

Expected: install succeeds (creates `payroll/node_modules` + `payroll/bun.lock` only), build passes, page renders.

- [ ] **Step 10: Commit**

```bash
git add payroll
git commit -m "feat(payroll): scaffold vite react app linked to local sdk"
```

---

### Task 2: Config + format helpers

**Files:**
- Create: `payroll/src/lib/config.ts`, `payroll/src/lib/format.ts`, `payroll/src/lib/types.ts`
- Test: `payroll/src/lib/config.test.ts`

**Interfaces:**
- Produces:
  - `config.get(): { backendUrl: string; rpcUrl: string }`, `config.set(patch: Partial<{ backendUrl; rpcUrl }>): void`, `config.apply(): void` (calls SDK `setBackendUrl`)
  - `format.shortHash(s, head?, tail?)`, `format.lamportsToSol(n)`, `format.solToLamports(n)`, `format.rawToHuman(raw: bigint, decimals: number): string`
  - `types.Asset`, `types.PayrollEntry`, `types.EntryStatus`, `types.ReceiptEntry`, `types.RunReceipt`, `types.ParsedFile`

- [ ] **Step 1: Write `src/lib/types.ts`** (shared shapes; every later task imports from here):

```ts
export type Asset =
  | { kind: "sol" }
  | { kind: "spl"; mint: string; decimals: number }

/** One row of an uploaded payroll file. amountHuman is the EXACT net the employee must receive. */
export interface PayrollEntry {
  address: string
  amountHuman: string
  memo?: string
}

export interface ParsedFile {
  entries: PayrollEntry[]
  fileHash: string
}

export type EntryStatus =
  | "queued"
  | "proving"
  | "relayed"
  | "confirmed"
  | "confirming"
  | "failed"

export interface ReceiptEntry {
  address: string
  amountHuman: string
  memo?: string
  status: "sent" | "failed" | "confirming"
  txSignature?: string
  error?: string
  attempts: number
}

export interface RunReceipt {
  id: string
  createdAt: number
  fileHash: string
  asset: Asset
  mode: "public"
  totalPlanned: bigint
  entries: ReceiptEntry[]
  funding?: { depositedRaw: bigint; txSignature: string } | null
  summary: { sent: number; failed: number; total: number }
}
```

- [ ] **Step 2: Write the failing test `src/lib/config.test.ts`**:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { config } from "./config"

describe("config", () => {
  beforeEach(() => localStorage.clear())

  it("returns defaults when nothing stored", () => {
    expect(config.get().backendUrl).toBe(
      "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
    )
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
  })

  it("persists overrides and survives re-read", () => {
    config.set({ backendUrl: "https://example.workers.dev" })
    expect(config.get().backendUrl).toBe("https://example.workers.dev")
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
  })

  it("rejects empty values in set", () => {
    config.set({ backendUrl: "https://x.dev" })
    config.set({ backendUrl: "" })
    expect(config.get().backendUrl).toBe("https://x.dev")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test`
Expected: FAIL — `./config` does not exist.

- [ ] **Step 4: Write `src/lib/config.ts`**:

```ts
import { setBackendUrl } from "privacy-cash-sdk"

export interface PayrollConfig {
  backendUrl: string
  rpcUrl: string
}

const KEY = "payroll:settings:v1"

const DEFAULTS: PayrollConfig = {
  backendUrl: "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
  rpcUrl: "https://api.devnet.solana.com",
}

function read(): PayrollConfig {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<PayrollConfig>
    return {
      backendUrl: parsed.backendUrl?.trim() || DEFAULTS.backendUrl,
      rpcUrl: parsed.rpcUrl?.trim() || DEFAULTS.rpcUrl,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export const config = {
  get: read,
  set(patch: Partial<PayrollConfig>): void {
    const next: PayrollConfig = { ...read() }
    if (patch.backendUrl?.trim()) next.backendUrl = patch.backendUrl.trim()
    if (patch.rpcUrl?.trim()) next.rpcUrl = patch.rpcUrl.trim()
    localStorage.setItem(KEY, JSON.stringify(next))
  },
  /** Point the SDK at the configured backend. Call once at app boot. */
  apply(): void {
    setBackendUrl(read().backendUrl)
  },
}
```

- [ ] **Step 5: Write `src/lib/format.ts`**:

```ts
export function shortHash(s: string, head = 8, tail = 6): string {
  if (!s) return s
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function lamportsToSol(lamports: number | string): number {
  return Number(lamports) / 1_000_000_000
}

export function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000)
}

export function isValidBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim())
}

/** Exact bigint formatting of a raw amount: no float math. */
export function rawToHuman(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  const s = frac ? `${whole}.${frac}` : `${whole}`
  return neg ? `-${s}` : s
}
```

- [ ] **Step 6: Run tests, verify pass, commit**

Run: `bun run test` → PASS (3 tests).

```bash
git add payroll
git commit -m "feat(payroll): config store, format helpers, shared types"
```

---

### Task 3: File parser

**Files:**
- Create: `payroll/src/lib/parse.ts`
- Test: `payroll/src/lib/parse.test.ts`

**Interfaces:**
- Consumes: `types.PayrollEntry`, `types.ParsedFile`.
- Produces:
  - `parsePayrollFile(text: string): { ok: true; entries: PayrollEntry[] } | { ok: false; errors: string[] }`
  - `hashFileBytes(bytes: Uint8Array): Promise<string>` (hex sha-256)
  - `validateDecimals(entries: PayrollEntry[], decimals: number): string[]`
  - `toRaw(human: string, decimals: number): bigint` (throws on malformed)

- [ ] **Step 1: Write the failing test `src/lib/parse.test.ts`**:

```ts
import { Keypair } from "@solana/web3.js"
import { describe, expect, it } from "vitest"
import { parsePayrollFile, toRaw, validateDecimals } from "./parse"

// Random on-curve keys (hardcoded devnet keys fail the on-curve check once edited).
const ADDR = Keypair.generate().toBase58()
const ADDR2 = Keypair.generate().toBase58()

describe("parsePayrollFile (JSON)", () => {
  it("parses the { payments: [...] } shape", () => {
    const r = parsePayrollFile(
      JSON.stringify({ payments: [{ address: ADDR, amount: 1.5, memo: "Oct" }] }),
    )
    expect(r).toEqual({
      ok: true,
      entries: [{ address: ADDR, amountHuman: "1.5", memo: "Oct" }],
    })
  })

  it("parses a bare array and string amounts", () => {
    const r = parsePayrollFile(JSON.stringify([{ address: ADDR, amount: "0.000000001" }]))
    expect(r.ok && r.entries[0].amountHuman).toBe("0.000000001")
    expect(r.ok && r.entries[0].memo).toBeUndefined()
  })

  it("rejects invalid pubkeys with row numbers", () => {
    const r = parsePayrollFile(JSON.stringify([{ address: "notakey", amount: 1 }]))
    expect(!r.ok && r.errors[0]).toMatch(/row 1: address/)
  })

  it("rejects non-positive and non-finite amounts", () => {
    const r = parsePayrollFile(
      JSON.stringify([
        { address: ADDR, amount: 0 },
        { address: ADDR, amount: -3 },
        { address: ADDR, amount: "abc" },
      ]),
    )
    expect(!r.ok && r.errors).toHaveLength(3)
  })

  it("rejects duplicate addresses citing both rows", () => {
    const r = parsePayrollFile(
      JSON.stringify([
        { address: ADDR, amount: 1 },
        { address: ADDR, amount: 2 },
      ]),
    )
    expect(!r.ok && r.errors[0]).toMatch(/row 2.*row 1|row 1.*row 2/)
  })

  it("rejects more than 200 entries", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      address: ADDR,
      amount: 1 + i * 0,
    }))
    const r = parsePayrollFile(JSON.stringify(many))
    expect(!r.ok && r.errors[0]).toMatch(/200/)
  })

  it("rejects malformed JSON and unknown shapes", () => {
    expect(!parsePayrollFile("{nope").ok)
    expect(!parsePayrollFile(JSON.stringify({ foo: 1 })).ok)
  })
})

describe("parsePayrollFile (CSV)", () => {
  it("parses header + rows, memo optional, quoted commas allowed", () => {
    const csv = `address,amount,memo\n${ADDR},1.5,"Doe, John"\n${ADDR2},2`
    const r = parsePayrollFile(csv)
    expect(r.ok && r.entries).toHaveLength(2)
    expect(r.ok && r.entries[0].memo).toBe("Doe, John")
    expect(r.ok && r.entries[1].memo).toBeUndefined()
  })

  it("accepts the two-column header too", () => {
    const r = parsePayrollFile(`address,amount\n${ADDR},1`)
    expect(r.ok && r.entries).toHaveLength(1)
  })

  it("requires the exact header", () => {
    expect(!parsePayrollFile("addr,amount\n" + ADDR + ",1").ok)
  })
})

describe("validateDecimals + toRaw", () => {
  it("flags too many decimals", () => {
    const errs = validateDecimals([{ address: ADDR, amountHuman: "1.1234567890" }], 9)
    expect(errs[0]).toMatch(/decimals/)
  })

  it("toRaw is exact", () => {
    expect(toRaw("1.5", 9)).toBe(1_500_000_000n)
    expect(toRaw("0.000000001", 9)).toBe(1n)
    expect(toRaw("42", 6)).toBe(42_000_000n)
  })

  it("toRaw rejects garbage", () => {
    expect(() => toRaw("1.2.3", 9)).toThrow()
    expect(() => toRaw("-1", 9)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test` → FAIL (module missing).

- [ ] **Step 3: Write `src/lib/parse.ts`**:

```ts
import { PublicKey } from "@solana/web3.js"

import type { PayrollEntry } from "./types"

export const MAX_ENTRIES = 200

export type ParseResult =
  | { ok: true; entries: PayrollEntry[] }
  | { ok: false; errors: string[] }

function isValidPubkey(s: string): boolean {
  try {
    const k = new PublicKey(s)
    return PublicKey.isOnCurve(k.toBytes())
  } catch {
    return false
  }
}

function normalizeAmount(v: unknown, row: number, errors: string[]): string | null {
  const n = typeof v === "number" ? v : Number(v)
  if (v === undefined || v === null || v === "" || Number.isNaN(n) || !Number.isFinite(n)) {
    errors.push(`row ${row}: amount "${String(v)}" is not a number`)
    return null
  }
  if (n <= 0) {
    errors.push(`row ${row}: amount must be greater than zero (got ${n})`)
    return null
  }
  return String(v)
}

/** RFC-lite CSV line split: honors double-quoted fields containing commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i++
      } else inQuotes = !inQuotes
    } else if (c === "," && !inQuotes) {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out.map((f) => f.trim())
}

function finalize(entries: PayrollEntry[], errors: string[]): ParseResult {
  const seen = new Map<string, number>()
  entries.forEach((e, i) => {
    const prior = seen.get(e.address)
    if (prior !== undefined)
      errors.push(`row ${i + 1}: duplicate address (already at row ${prior + 1}) — merge the rows and re-upload`)
    else seen.set(e.address, i + 1)
  })
  if (entries.length > MAX_ENTRIES)
    errors.push(`file has ${entries.length} entries; maximum is ${MAX_ENTRIES} per run`)
  return errors.length ? { ok: false, errors } : { ok: true, entries }
}

export function parsePayrollFile(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, errors: ["file is empty"] }
  const errors: string[] = []
  const entries: PayrollEntry[] = []

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`] }
    }
    const rows: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed &&
          typeof parsed === "object" &&
          Array.isArray((parsed as { payments?: unknown[] }).payments)
        ? (parsed as { payments: unknown[] }).payments
        : []
    if (!rows.length)
      return {
        ok: false,
        errors: ['JSON must be an array or { "payments": [ ... ] }'],
      }
    rows.forEach((raw, i) => {
      const row = i + 1
      const r = raw as { address?: unknown; amount?: unknown; memo?: unknown }
      const address = typeof r.address === "string" ? r.address.trim() : ""
      if (!address || !isValidPubkey(address)) {
        errors.push(`row ${row}: address "${address || String(r.address)}" is not a valid Solana pubkey`)
      }
      const amountHuman = normalizeAmount(r.amount, row, errors)
      const memo = typeof r.memo === "string" && r.memo.trim() ? r.memo.trim() : undefined
      if (address && amountHuman) entries.push({ address, amountHuman, memo })
    })
    return finalize(entries, errors)
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "")
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  if (header.join(",") !== "address,amount,memo" && header.join(",") !== "address,amount") {
    return {
      ok: false,
      errors: [`CSV header must be "address,amount,memo" (memo optional), got: ${lines[0]}`],
    }
  }
  const wantMemo = header.length === 3
  lines.slice(1).forEach((line, i) => {
    const row = i + 2
    const f = splitCsvLine(line)
    if (f.length < 2 || (!wantMemo && f.length > 2) || (wantMemo && f.length > 3)) {
      errors.push(`row ${row}: expected ${wantMemo ? "3" : "2 or 3"} columns, got ${f.length}`)
      return
    }
    const [address, amountRaw, memo] = f
    if (!isValidPubkey(address))
      errors.push(`row ${row}: address "${address}" is not a valid Solana pubkey`)
    const amountHuman = normalizeAmount(amountRaw, row, errors)
    if (address && amountHuman)
      entries.push({ address, amountHuman, memo: memo || undefined })
  })
  return finalize(entries, errors)
}

export async function hashFileBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function validateDecimals(entries: PayrollEntry[], decimals: number): string[] {
  const errors: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const frac = entries[i].amountHuman.split(".")[1] ?? ""
    if (frac.length > decimals)
      errors.push(
        `row ${i + 1}: amount ${entries[i].amountHuman} has ${frac.length} decimals; this asset allows ${decimals}`,
      )
  }
  return errors
}

/** Exact string->bigint conversion; throws on anything malformed. */
export function toRaw(human: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(human.trim())
  if (!m) throw new Error(`bad amount: ${human}`)
  const whole = m[1]
  const frac = (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals + 1)
  if (frac.length > decimals) throw new Error(`too many decimals in ${human}`)
  return BigInt(whole + frac)
}
```

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `bun run test` → PASS.

```bash
git add payroll
git commit -m "feat(payroll): json/csv payroll file parser with row-level validation"
```

---

### Task 4: Net-exact fee math + run planner

**Files:**
- Create: `payroll/src/lib/fees.ts`
- Test: `payroll/src/lib/fees.test.ts`

**Interfaces:**
- Consumes: `types.PayrollEntry`, `parse.toRaw`.
- Produces:
  - `feeFor(gross: bigint, bps: number): bigint` — `ceil(gross * bps / 10_000)`
  - `solveGross(net: bigint, bps: number): bigint` — smallest gross with `gross − feeFor(gross) === net`
  - `planRun(entries, decimals, bps, vaultRaw): RunPlan` with `{ rows: { address; memo?; net; gross; fee }[]; totalNet; totalGross; totalFees; margin; vaultRaw; shortfall }`

- [ ] **Step 1: Write the failing test `src/lib/fees.test.ts`**:

```ts
import { describe, expect, it } from "vitest"
import { feeFor, planRun, solveGross } from "./fees"

describe("feeFor", () => {
  it("ceil-rounds like the SDK does", () => {
    expect(feeFor(1_000_000_000n, 100)).toBe(10_000_000n)
    expect(feeFor(1n, 100)).toBe(1n)
    expect(feeFor(0n, 100)).toBe(0n)
  })
})

describe("solveGross", () => {
  it("nets exactly at 0 bps", () => {
    expect(solveGross(123n, 0)).toBe(123n)
  })

  it("nets exactly for representative cases (property: gross - feeFor(gross) == net)", () => {
    const nets = [1n, 999n, 1_500_000_000n, 2_000_000_123n, 10n ** 15n]
    for (const bps of [0, 10, 50, 100, 250]) {
      for (const net of nets) {
        const g = solveGross(net, bps)
        expect(g - feeFor(g, bps)).toBe(net)
        expect(g).toBeGreaterThanOrEqual(net)
      }
    }
  })

  it("is minimal at 1 bps", () => {
    expect(solveGross(10_000n, 1)).toBe(10_001n)
  })
})

describe("planRun", () => {
  const entries = [
    { address: "A".repeat(32), amountHuman: "1.5" },
    { address: "B".repeat(32), amountHuman: "0.5", memo: "bonus" },
  ]

  it("computes totals, margin, and shortfall", () => {
    const p = planRun(entries, 9, 100, 1_000_000_000n)
    expect(p.rows).toHaveLength(2)
    const grossSum = p.rows.reduce((s, r) => s + r.gross, 0n)
    expect(p.totalGross).toBe(grossSum)
    expect(p.totalNet).toBe(2_000_000_000n)
    expect(p.margin).toBe(feeFor(1_500_000_151n, 100))
    expect(p.shortfall).toBe(p.totalGross + p.margin - 1_000_000_000n)
  })

  it("shortfall floors at zero when vault covers", () => {
    const p = planRun(entries, 9, 100, 10n ** 18n)
    expect(p.shortfall).toBe(0n)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test` → FAIL.

- [ ] **Step 3: Write `src/lib/fees.ts`**:

```ts
import { toRaw } from "./parse"
import type { PayrollEntry } from "./types"

/** Relayer fee for a gross amount: ceil(gross * bps / 10_000) — mirrors withdrawInternal. */
export function feeFor(gross: bigint, bps: number): bigint {
  if (bps <= 0) return 0n
  return (gross * BigInt(bps) + 9_999n) / 10_000n
}

/**
 * Smallest gross such that gross - feeFor(gross, bps) === net.
 * Start from the closed-form estimate, then walk to the exact fixed point.
 */
export function solveGross(net: bigint, bps: number): bigint {
  if (bps <= 0) return net
  let g = (net * 10_000n + BigInt(10_000 - bps) - 1n) / BigInt(10_000 - bps)
  while (g - feeFor(g, bps) > net) g -= 1n
  while (g - feeFor(g, bps) < net) g += 1n
  return g
}

export interface RunPlanRow {
  address: string
  memo?: string
  net: bigint
  gross: bigint
  fee: bigint
}

export interface RunPlan {
  rows: RunPlanRow[]
  totalNet: bigint
  totalGross: bigint
  totalFees: bigint
  margin: bigint
  vaultRaw: bigint
  shortfall: bigint
}

export function planRun(
  entries: PayrollEntry[],
  decimals: number,
  bps: number,
  vaultRaw: bigint,
): RunPlan {
  const rows = entries.map((e) => {
    const net = toRaw(e.amountHuman, decimals)
    const gross = solveGross(net, bps)
    return { address: e.address, memo: e.memo, net, gross, fee: feeFor(gross, bps) }
  })
  const totalNet = rows.reduce((s, r) => s + r.net, 0n)
  const totalGross = rows.reduce((s, r) => s + r.gross, 0n)
  const totalFees = rows.reduce((s, r) => s + r.fee, 0n)
  const maxGross = rows.reduce((m, r) => (r.gross > m ? r.gross : m), 0n)
  const margin = feeFor(maxGross, bps)
  const shortfall = totalGross + margin > vaultRaw ? totalGross + margin - vaultRaw : 0n
  return { rows, totalNet, totalGross, totalFees, margin, vaultRaw, shortfall }
}
```

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `bun run test` → PASS.

```bash
git add payroll
git commit -m "feat(payroll): net-exact gross solver and run planner"
```

---

### Task 5: Receipt history

**Files:**
- Create: `payroll/src/lib/history.ts`
- Test: `payroll/src/lib/history.test.ts`

**Interfaces:**
- Consumes: `types.RunReceipt`, `types.PayrollEntry`.
- Produces (from `history.ts`, re-exporting `store.ts` mechanics):
  - `saveRun(r: RunReceipt): void` (FIFO-trims to 50)
  - `listRuns(): RunReceipt[]` (newest first)
  - `getRun(id: string): RunReceipt | null`
  - `failedEntriesOf(r: RunReceipt): PayrollEntry[]`
  - `runToJson(r: RunReceipt): string`
  - `runToCsv(r: RunReceipt): string`
  - `downloadRun(r: RunReceipt, fmt: "json" | "csv"): void`
  - `clearAll(): void`
  - `storageOk(): boolean` (startup probe for the UI warning banner)

- [ ] **Step 1: Write the failing test `src/lib/history.test.ts`**:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import {
  clearAll,
  failedEntriesOf as failedEntries,
  listRuns,
  runToCsv,
  saveRun,
} from "./history"
import type { RunReceipt } from "./types"

function receipt(id: string, over?: Partial<RunReceipt>): RunReceipt {
  return {
    id,
    createdAt: 1_700_000_000_000,
    fileHash: "ab".repeat(32),
    asset: { kind: "sol" },
    mode: "public",
    totalPlanned: 2n,
    entries: [
      { address: "A".repeat(32), amountHuman: "1.5", status: "sent", txSignature: "sig1", attempts: 1 },
      { address: "B".repeat(32), amountHuman: "0.5", memo: "m", status: "failed", error: "boom", attempts: 3 },
    ],
    funding: { depositedRaw: 3n, txSignature: "fund" },
    summary: { sent: 1, failed: 1, total: 2 },
    ...over,
  }
}

describe("history", () => {
  beforeEach(() => localStorage.clear())

  it("saves and lists newest-first", () => {
    saveRun(receipt("a", { createdAt: 1 }))
    saveRun(receipt("b", { createdAt: 2 }))
    expect(listRuns().map((r) => r.id)).toEqual(["b", "a"])
  })

  it("trims to 50 runs", () => {
    for (let i = 0; i < 55; i++) saveRun(receipt(`r${i}`))
    expect(listRuns()).toHaveLength(50)
    expect(listRuns()[0].id).toBe("r54")
  })

  it("survives corrupt storage gracefully", () => {
    localStorage.setItem("payroll:history:v1", "{oops")
    saveRun(receipt("a"))
    expect(listRuns().map((r) => r.id)).toEqual(["a"])
  })

  it("failedEntries returns failed rows as payroll entries", () => {
    const f = failedEntries(receipt("a"))
    expect(f).toEqual([{ address: "B".repeat(32), amountHuman: "0.5", memo: "m" }])
  })

  it("csv export has header + one row per entry", () => {
    const csv = runToCsv(receipt("a"))
    const lines = csv.trim().split("\n")
    expect(lines[0]).toBe("address,amount,memo,status,tx_signature,error")
    expect(lines).toHaveLength(3)
    expect(lines[2]).toContain("failed")
    expect(lines[2]).toContain("boom")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test` → FAIL.

- [ ] **Step 3: Write `src/lib/history.ts`**:

```ts
import { failedEntriesOf, getRun, listRuns, saveRun, clearAll } from "./store"
import type { PayrollEntry, RunReceipt } from "./types"

export { failedEntriesOf, getRun, listRuns, saveRun, clearAll }

export function runToJson(r: RunReceipt): string {
  return JSON.stringify(
    { ...r, totalPlanned: r.totalPlanned.toString(), funding: r.funding
        ? { ...r.funding, depositedRaw: r.funding.depositedRaw.toString() }
        : null },
    null,
    2,
  )
}

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function runToCsv(r: RunReceipt): string {
  const head = "address,amount,memo,status,tx_signature,error"
  const lines = r.entries.map((e) =>
    [
      e.address,
      e.amountHuman,
      e.memo ?? "",
      e.status,
      e.txSignature ?? "",
      e.error ?? "",
    ]
      .map(csvField)
      .join(","),
  )
  return [head, ...lines].join("\n") + "\n"
}

export function downloadRun(r: RunReceipt, fmt: "json" | "csv"): void {
  const blob = new Blob([fmt === "json" ? runToJson(r) : runToCsv(r)], {
    type: fmt === "json" ? "application/json" : "text/csv",
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `payroll-${r.id}.${fmt}`
  a.click()
  URL.revokeObjectURL(url)
}
```

And `src/lib/store.ts` (the localStorage mechanics, separate from export formatting):

```ts
import type { PayrollEntry, RunReceipt } from "./types"

const KEY = "payroll:history:v1"
const MAX_RUNS = 50

function revive(r: unknown): RunReceipt {
  const x = r as RunReceipt & { totalPlanned?: string | bigint }
  return { ...x, totalPlanned: BigInt(x.totalPlanned as string | bigint) }
}

export function listRuns(): RunReceipt[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as RunReceipt[]
    if (!Array.isArray(arr)) return []
    return arr
      .map(revive)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function getRun(id: string): RunReceipt | null {
  return listRuns().find((r) => r.id === id) ?? null
}

export function saveRun(receipt: RunReceipt): void {
  const existing = listRuns().filter((r) => r.id !== receipt.id)
  const next = [receipt, ...existing]
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, MAX_RUNS)))
  } catch {
    /* receiptless operation is acceptable; the UI warns once (App storage probe) */
  }
}

export function clearAll(): void {
  localStorage.removeItem(KEY)
}

export function failedEntriesOf(r: RunReceipt): PayrollEntry[] {
  return r.entries
    .filter((e) => e.status === "failed")
    .map((e) => ({ address: e.address, amountHuman: e.amountHuman, memo: e.memo }))
}

/** Probe localStorage availability once at startup for the UI warning banner. */
export function storageOk(): boolean {
  try {
    localStorage.setItem("payroll:probe", "1")
    localStorage.removeItem("payroll:probe")
    return true
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `bun run test` → PASS.

```bash
git add payroll
git commit -m "feat(payroll): localStorage run receipts with json/csv export"
```

---

### Task 6: Run engine

**Files:**
- Create: `payroll/src/lib/engine.ts`
- Test: `payroll/src/lib/engine.test.ts`

**Interfaces:**
- Consumes: `fees.planRun`, `history.saveRun`, `types.*`, SDK client surface (structural subset — mockable).
- Produces:
  - `type RowState = { address: string; amountHuman: string; memo?: string; status: EntryStatus; txSignature?: string; error?: string; attempts: number }`
  - `type RunSnapshot = { phase: "funding" | "paying" | "settled" | "aborted"; rows: RowState[]; depositSig?: string }`
  - `type EngineClient` (structural subset of `PrivacyCashClient`: `init/unlock/refreshNotes/depositSOL/depositSPL/withdrawSOL/withdrawSPL`)
  - `class PayrollEngine { constructor(deps); run(req, onUpdate?): Promise<RunReceipt>; cancel(): void }`
  - `type RunRequest = { fileHash: string; asset: Asset; entries: PayrollEntry[]; bps: number; vaultRaw: bigint }`
  - `createEngine(client: EngineClient): PayrollEngine` — wires real `waitUntilIndexed` (SDK `fetchTreeState` polling) and `confirmSignature` (RPC status polling via `config.get().rpcUrl`).

- [ ] **Step 1: Write the failing test `src/lib/engine.test.ts`**:

```ts
import { describe, expect, it } from "vitest"
import { PayrollEngine, type EngineClient, type RunRequest } from "./engine"
import type { Asset, PayrollEntry } from "./types"

const E: PayrollEntry[] = [
  { address: "A".repeat(32), amountHuman: "1" },
  { address: "B".repeat(32), amountHuman: "2" },
  { address: "C".repeat(32), amountHuman: "3", memo: "x" },
]

function req(over?: Partial<RunRequest>): RunRequest {
  return {
    fileHash: "ff".repeat(32),
    asset: { kind: "sol" } as Asset,
    entries: E,
    bps: 100,
    vaultRaw: 0n,
    ...over,
  }
}

type Ctl = {
  fails: Map<string, number> // address -> failures before success
  rejectDeposit?: Error
  slow?: number
}

function mockClient(ctl: Ctl) {
  const calls = { deposits: [] as number[], withdraws: [] as Array<[number, string]>, refreshes: 0 }
  const client: EngineClient = {
    init: async () => {},
    unlock: async () => {},
    refreshNotes: async () => {
      calls.refreshes++
    },
    depositSOL: async (lamports: number) => {
      if (ctl.rejectDeposit) throw ctl.rejectDeposit
      calls.deposits.push(lamports)
      return { signature: "DEP", amountLamports: lamports, leafIndex: 41 }
    },
    depositSPL: async (_m: string, raw: number) => {
      calls.deposits.push(raw)
      return { signature: "DEP", amountLamports: raw, leafIndex: 41 }
    },
    withdrawSOL: async (lamports: number, recipient: string) => {
      if (ctl.slow) await new Promise((r) => setTimeout(r, ctl.slow))
      const left = ctl.fails.get(recipient) ?? 0
      if (left > 0) {
        ctl.fails.set(recipient, left - 1)
        throw new Error("relayer 503")
      }
      calls.withdraws.push([lamports, recipient])
      return { signature: `SIG-${recipient[0]}`, recipientLamports: lamports, feeLamports: 0, changeLamports: "0" }
    },
    withdrawSPL: async (_m: string, raw: number, recipient: string) => {
      calls.withdraws.push([raw, recipient])
      return { signature: `SIG-${recipient[0]}`, recipientLamports: raw, feeLamports: 0, changeLamports: "0" }
    },
  }
  return { client, calls }
}

function deps(client: EngineClient, extra?: {
  waitUntilIndexed?: () => Promise<void>
  confirm?: (sig: string) => Promise<boolean>
}) {
  return {
    client,
    waitUntilIndexed: extra?.waitUntilIndexed ?? (async () => {}),
    confirmSignature: extra?.confirm ?? (async () => true),
    now: () => 1,
    newId: () => "run1",
    sleep: async () => {},
  }
}

describe("PayrollEngine", () => {
  it("deposits the shortfall once, pays every entry, confirms, and writes a receipt", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    const snapshots: unknown[] = []
    const receipt = await engine.run(req(), (s) => snapshots.push({ ...s }))
    expect(calls.deposits).toHaveLength(1)
    expect(calls.withdraws).toHaveLength(3)
    expect(receipt.summary).toEqual({ sent: 3, failed: 0, total: 3 })
    expect(receipt.entries.every((e) => e.status === "sent")).toBe(true)
    expect(receipt.funding?.txSignature).toBe("DEP")
    expect(snapshots.at(-1)!.phase).toBe("settled")
  })

  it("skips the deposit when the vault covers the run", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    await engine.run(req({ vaultRaw: 10n ** 18n }))
    expect(calls.deposits).toHaveLength(0)
    expect(calls.withdraws).toHaveLength(3)
  })

  it("retries a failing payout 3 times, then marks it failed and continues", async () => {
    const { client, calls } = mockClient({ fails: new Map([["B".repeat(32), 99]]) })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n }))
    expect(receipt.entries[1].status).toBe("failed")
    expect(receipt.entries[1].attempts).toBe(3)
    expect(receipt.entries[0].status).toBe("sent")
    expect(receipt.entries[2].status).toBe("sent")
    expect(calls.withdraws).toHaveLength(2)
  })

  it("recovers when earlier attempts fail then succeed", async () => {
    const { client, calls } = mockClient({ fails: new Map([["A".repeat(32), 2]]) })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n }))
    expect(receipt.entries[0].status).toBe("sent")
    expect(receipt.entries[0].attempts).toBe(3)
    expect(calls.withdraws).toHaveLength(3)
  })

  it("aborts with zero payouts when the wallet rejects the deposit", async () => {
    const { client, calls } = mockClient({
      fails: new Map(),
      rejectDeposit: new Error("User rejected the request"),
    })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req())
    expect(calls.withdraws).toHaveLength(0)
    expect(receipt.entries.every((e) => e.status === "failed")).toBe(true)
    expect(receipt.entries[0].error).toMatch(/funding failed/i)
  })

  it("marks unconfirmed payouts as confirming, not failed", async () => {
    const { client } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client, { confirm: async () => false }))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n }))
    expect(receipt.entries.every((e) => e.status === "confirming")).toBe(true)
  })

  it("cancel() stops between entries and leaves the rest failed-cancelled", async () => {
    const { client, calls } = mockClient({ fails: new Map(), slow: 10 })
    const engine = new PayrollEngine(deps(client))
    const p = engine.run(req({ vaultRaw: 10n ** 18n }))
    setTimeout(() => engine.cancel(), 15)
    const receipt = await p
    const statuses = receipt.entries.map((e) => e.status)
    expect(statuses[statuses.length - 1]).toBe("failed")
    expect(receipt.entries.find((e) => e.error === "cancelled")?.status).toBe("failed")
    expect(calls.withdraws.length).toBeLessThan(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test` → FAIL.

- [ ] **Step 3: Write `src/lib/engine.ts`**:

```ts
import { Connection } from "@solana/web3.js"
import { fetchTreeState, solTreeKey, splTreeKey } from "privacy-cash-sdk"

import { config } from "./config"
import { planRun } from "./fees"
import { saveRun } from "./store"
import type { Asset, EntryStatus, PayrollEntry, RunReceipt } from "./types"

export interface RowState {
  address: string
  amountHuman: string
  memo?: string
  status: EntryStatus
  txSignature?: string
  error?: string
  attempts: number
}

export interface RunSnapshot {
  phase: "funding" | "paying" | "settled" | "aborted"
  rows: RowState[]
  depositSig?: string
}

export interface RunRequest {
  fileHash: string
  asset: Asset
  entries: PayrollEntry[]
  bps: number
  vaultRaw: bigint
}

export interface EngineClient {
  init(): Promise<void>
  unlock(): Promise<void>
  refreshNotes(): Promise<unknown>
  depositSOL(lamports: number): Promise<{ signature: string; leafIndex: number }>
  depositSPL(mint: string, raw: number | string): Promise<{ signature: string; leafIndex: number }>
  withdrawSOL(
    lamports: number,
    recipient: string,
    opts?: { relay?: boolean },
  ): Promise<{ signature: string }>
  withdrawSPL(
    mint: string,
    raw: number | string,
    recipient: string,
    opts?: { relay?: boolean },
  ): Promise<{ signature: string }>
}

export interface EngineDeps {
  client: EngineClient
  waitUntilIndexed(treeKey: string, minLeafIndex: number): Promise<void>
  confirmSignature(sig: string): Promise<boolean>
  now(): number
  newId(): string
  sleep(ms: number): Promise<void>
}

const ATTEMPTS = 3

export class PayrollEngine {
  private cancelled = false
  private emit: (phase: RunSnapshot["phase"], depositSig?: string) => void = () => {}

  constructor(private deps: EngineDeps) {}

  cancel(): void {
    this.cancelled = true
  }

  async run(req: RunRequest, onUpdate?: (s: RunSnapshot) => void): Promise<RunReceipt> {
    this.cancelled = false
    const decimals = req.asset.kind === "sol" ? 9 : req.asset.decimals
    const plan = planRun(req.entries, decimals, req.bps, req.vaultRaw)
    const rows: RowState[] = req.entries.map((e) => ({
      address: e.address,
      amountHuman: e.amountHuman,
      memo: e.memo,
      status: "queued",
      attempts: 0,
    }))
    this.emit = (phase, depositSig) =>
      onUpdate?.({ phase, rows: rows.map((r) => ({ ...r })), depositSig })

    await this.deps.client.init()
    await this.deps.client.unlock()

    let funding: RunReceipt["funding"] = null
    if (plan.shortfall > 0n) {
      this.emit("funding")
      try {
        const lamports = Number(plan.shortfall)
        if (!Number.isSafeInteger(lamports)) throw new Error("shortfall too large")
        const dep =
          req.asset.kind === "sol"
            ? await this.deps.client.depositSOL(lamports)
            : await this.deps.client.depositSPL(req.asset.mint, lamports)
        await this.deps.waitUntilIndexed(treeKeyOf(req.asset), dep.leafIndex)
        await this.deps.client.refreshNotes()
        funding = { depositedRaw: plan.shortfall, txSignature: dep.signature }
        this.emit("funding", dep.signature)
      } catch (e) {
        for (const r of rows) {
          r.status = "failed"
          r.error = `aborted: funding failed — ${(e as Error).message}`
        }
        return this.settle(req, plan.totalNet, rows, funding, "aborted")
      }
    }

    this.emit("paying", funding?.txSignature)
    for (let i = 0; i < rows.length; i++) {
      if (this.cancelled) {
        for (const r of rows.slice(i)) {
          r.status = "failed"
          r.error = "cancelled"
        }
        break
      }
      const row = rows[i]
      const gross = plan.rows[i].gross
      const amount = Number(gross)
      if (!Number.isSafeInteger(amount)) {
        row.status = "failed"
        row.error = "amount exceeds safe integer range"
        continue
      }
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        row.attempts = attempt
        row.status = "proving"
        this.emit("paying", funding?.txSignature)
        try {
          const res =
            req.asset.kind === "sol"
              ? await this.deps.client.withdrawSOL(amount, row.address, { relay: true })
              : await this.deps.client.withdrawSPL(req.asset.mint, amount, row.address, { relay: true })
          row.txSignature = res.signature
          row.status = "relayed"
          this.emit("paying", funding?.txSignature)
          row.status = (await this.deps.confirmSignature(res.signature)) ? "confirmed" : "confirming"
          this.emit("paying", funding?.txSignature)
          break
        } catch (e) {
          row.error = (e as Error).message
          if (attempt === ATTEMPTS) row.status = "failed"
          else await this.deps.sleep(500 * 2 ** (attempt - 1))
        }
      }
      await this.deps.client.refreshNotes()
    }

    return this.settle(req, plan.totalNet, rows, funding, "settled")
  }

  private settle(
    req: RunRequest,
    totalPlanned: bigint,
    rows: RowState[],
    funding: RunReceipt["funding"],
    phase: RunSnapshot["phase"],
  ): RunReceipt {
    const entries = rows.map((r) => ({
      address: r.address,
      amountHuman: r.amountHuman,
      memo: r.memo,
      status: r.status === "confirmed" ? "sent" : r.status === "confirming" ? "confirming" : "failed",
      txSignature: r.txSignature,
      error: r.error,
      attempts: r.attempts,
    }))
    const receipt: RunReceipt = {
      id: this.deps.newId(),
      createdAt: this.deps.now(),
      fileHash: req.fileHash,
      asset: req.asset,
      mode: "public",
      totalPlanned,
      entries,
      funding,
      summary: {
        sent: entries.filter((e) => e.status === "sent").length,
        failed: entries.filter((e) => e.status === "failed").length,
        total: entries.length,
      },
    }
    saveRun(receipt)
    this.emit(phase, funding?.txSignature)
    return receipt
  }
}

export function treeKeyOf(asset: Asset): string {
  return asset.kind === "sol" ? solTreeKey() : splTreeKey(asset.mint)
}

async function defaultWaitUntilIndexed(treeKey: string, minLeafIndex: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const st = await fetchTreeState(treeKey)
      if (st.nextLeafIndex > minLeafIndex) return
    } catch {
      /* transient indexer hiccup — retry */
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error(`merkle tree did not index leaf ${minLeafIndex} within ${timeoutMs}ms`)
}

async function defaultConfirm(sig: string): Promise<boolean> {
  const conn = new Connection(config.get().rpcUrl, "confirmed")
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })
      const st = value?.[0]
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return true
      if (st?.err) return false
    } catch {
      /* rate limit — retry */
    }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return false
}

export function createEngine(client: EngineClient): PayrollEngine {
  return new PayrollEngine({
    client,
    waitUntilIndexed: defaultWaitUntilIndexed,
    confirmSignature: defaultConfirm,
    now: () => Date.now(),
    newId: () =>
      Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
}
```

**Cleanup requirement:** deleted — the code above is already the clean version (emit is a class field; no leftover scaffolding).

- [ ] **Step 4: Run tests, verify pass, commit**

Run: `bun run test` → PASS (engine + all prior suites).

```bash
git add payroll
git commit -m "feat(payroll): run engine — fund shortfall, sequential relayed payouts, retries, receipts"
```

---

### Task 7: Wallet hook + providers + WalletBar + SettingsDrawer

**Files:**
- Create: `payroll/src/components/WalletProvider.tsx`, `payroll/src/components/WalletBar.tsx`, `payroll/src/components/SettingsDrawer.tsx`
- Modify: `payroll/src/main.tsx` (wrap providers, apply config, Toaster)

**Interfaces:**
- Consumes: `config`, SDK `PrivacyCashClient`, `fetchRelayerInfo`, `totalBalance`, `WRAPPED_SOL_MINT`.
- Produces: `usePayrollClient(): { client: PrivacyCashClient | null; ready: boolean; busy: boolean; error: string | null; vaultSolRaw: bigint | null; bps: number | null; connect(): void; refreshVault(): Promise<void> }`

- [ ] **Step 1: Create `src/components/WalletProvider.tsx`**:

```tsx
import { useMemo, type ReactNode } from "react"
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react"
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui"
import "@solana/wallet-adapter-react-ui/styles.css"

import { config } from "@/lib/config"

export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], [])
  return (
    <ConnectionProvider endpoint={config.get().rpcUrl} config={{ commitment: "confirmed" }}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  )
}

export function useConnectWallet() {
  const { setVisible } = useWalletModal()
  return { open: () => setVisible(true) }
}
```

- [ ] **Step 2: Create `src/hooks/usePayrollClient.ts`**:

```ts
import { useCallback, useEffect, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import {
  PrivacyCashClient,
  fetchRelayerInfo,
  totalBalance,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

export function usePayrollClient() {
  const { publicKey, signMessage, signTransaction, connect } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [vaultSolRaw, setVaultSolRaw] = useState<bigint | null>(null)
  const [bps, setBps] = useState<number | null>(null)
  const clientRef = useRef<PrivacyCashClient | null>(null)
  const [client, setClient] = useState<PrivacyCashClient | null>(null)

  const connected = !!(publicKey && signMessage && signTransaction)

  useEffect(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) return
    const c = new PrivacyCashClient({ publicKey, signMessage, signTransaction })
    clientRef.current = c
    setClient(c)
    setBusy(true)
    setError(null)
    ;(async () => {
      try {
        await c.init()
        const info = await fetchRelayerInfo()
        setBps(info.withdrawalFeeRateBps)
        await c.unlock() // wallet signature popup: derives the note keypair
        await c.refreshNotes()
        setVaultSolRaw(totalBalance(publicKey, WRAPPED_SOL_MINT))
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    })()
  }, [connected, publicKey, signMessage, signTransaction])

  const refreshVault = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    await c.refreshNotes()
    setVaultSolRaw(totalBalance(c.publicKey, WRAPPED_SOL_MINT))
  }, [])

  return { client, ready: connected && !!client && !busy, busy, error, vaultSolRaw, bps, connect, refreshVault }
}
```

- [ ] **Step 3: Create `src/components/WalletBar.tsx`**:

```tsx
import { useWallet } from "@solana/wallet-adapter-react"
import { Wallet } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { lamportsToSol, shortHash } from "@/lib/format"

export function WalletBar({
  vaultSolRaw,
  relayerOk,
  onOpenSettings,
}: {
  vaultSolRaw: bigint | null
  relayerOk: boolean | null
  onOpenSettings: () => void
}) {
  const { publicKey, disconnect } = useWallet()
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Badge variant={relayerOk === null ? "secondary" : relayerOk ? "default" : "destructive"}>
          {relayerOk === null ? "relayer…" : relayerOk ? "relayer up" : "relayer down"}
        </Badge>
        {vaultSolRaw !== null && (
          <Badge variant="outline">vault {lamportsToSol(vaultSolRaw.toString()).toFixed(4)} SOL</Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
        </Button>
        {publicKey ? (
          <>
            <Badge variant="outline" className="font-mono">
              <Wallet className="mr-1 size-3" />
              {shortHash(publicKey.toBase58())}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => disconnect()}>
              Disconnect
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Create `src/components/SettingsDrawer.tsx`**:

```tsx
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { config } from "@/lib/config"

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const [backendUrl, setBackendUrl] = useState(config.get().backendUrl)
  const [rpcUrl, setRpcUrl] = useState(config.get().rpcUrl)

  const save = () => {
    config.set({ backendUrl, rpcUrl })
    location.reload()
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-96 max-w-full overflow-y-auto bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 text-lg font-semibold">Settings</h2>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="backend">Backend URL (relayer)</Label>
            <Input id="backend" value={backendUrl} onChange={(e) => setBackendUrl(e.target.value)} placeholder="https://…workers.dev" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="rpc">Solana RPC URL</Label>
            <Input id="rpc" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} placeholder="https://api.devnet.solana.com" />
          </div>
          <p className="text-xs text-muted-foreground">
            Saving reloads the app so the SDK re-points at the new backend.
          </p>
          <div className="flex gap-2">
            <Button onClick={save}>Save &amp; reload</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Update `src/main.tsx`**:

```tsx
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { SolanaProviders } from "@/components/WalletProvider"
import { Toaster } from "@/components/ui/sonner"
import { config } from "@/lib/config"

config.apply()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
      <Toaster />
    </SolanaProviders>
  </StrictMode>,
)
```

- [ ] **Step 6: Verify boot and commit**

Run: `bun run dev`, open http://localhost:5174 — page loads with no console errors (relayer badge may show up/down depending on network); `bun run build` passes.

```bash
git add payroll
git commit -m "feat(payroll): wallet providers, client hook, wallet bar, settings drawer"
```

---

### Task 8: UploadCard + PlanReviewCard

**Files:**
- Create: `payroll/src/components/UploadCard.tsx`, `payroll/src/components/PlanReviewCard.tsx`

**Interfaces:**
- Consumes: `parsePayrollFile`, `hashFileBytes`, `validateDecimals`, `planRun`, `format`, `types`.
- Produces (props consumed by App):
  - `<UploadCard onParsed={ (p: ParsedFile | null) => void } />`
  - `<PlanReviewCard parsed bps vaultSolRaw onRun={(asset: Asset) => void} />`

- [ ] **Step 1: Create `src/components/UploadCard.tsx`**:

```tsx
import { useRef, useState } from "react"
import { toast } from "sonner"
import { FileUp } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { hashFileBytes, parsePayrollFile } from "@/lib/parse"
import { shortHash } from "@/lib/format"
import type { ParsedFile } from "@/lib/types"

export function UploadCard({ onParsed }: { onParsed: (p: ParsedFile | null) => void }) {
  const [errors, setErrors] = useState<string[]>([])
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [paste, setPaste] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const ingest = async (text: string, bytes?: Uint8Array) => {
    const r = parsePayrollFile(text)
    if (!r.ok) {
      setParsed(null)
      setErrors(r.errors)
      onParsed(null)
      return
    }
    const fileHash = bytes
      ? await hashFileBytes(bytes)
      : await hashFileBytes(new TextEncoder().encode(text))
    const p: ParsedFile = { entries: r.entries, fileHash }
    setErrors([])
    setParsed(p)
    onParsed(p)
    toast.success(`Parsed ${r.entries.length} payments`)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="size-4" /> Upload payroll file
        </CardTitle>
        <CardDescription>
          JSON <code>{"{ payments: [{ address, amount, memo }] }"}</code> or CSV with header
          <code> address,amount,memo</code>. Amounts are what each employee receives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            const bytes = new Uint8Array(await f.arrayBuffer())
            await ingest(new TextDecoder().decode(bytes), bytes)
          }}
        />
        <div className="flex gap-2">
          <Button onClick={() => fileRef.current?.click()}>Choose file</Button>
          <Button variant="outline" disabled={!paste.trim()} onClick={() => ingest(paste)}>
            Parse pasted text
          </Button>
        </div>
        <Textarea
          placeholder='Paste JSON or CSV here…'
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          className="font-mono text-xs"
        />
        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>File rejected — fix and re-upload</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {errors.slice(0, 12).map((err, i) => (
                  <li key={i} className="font-mono text-xs">{err}</li>
                ))}
                {errors.length > 12 && <li>…and {errors.length - 12} more</li>}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {parsed && (
          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>{parsed.entries.length} payments · file {shortHash(parsed.fileHash, 6, 4)}</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">#</th>
                    <th className="px-3 py-1.5 font-medium">Address</th>
                    <th className="px-3 py-1.5 font-medium text-right">Amount</th>
                    <th className="px-3 py-1.5 font-medium">Memo</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.entries.map((e, i) => (
                    <tr key={e.address} className="border-t">
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono">{shortHash(e.address, 6, 4)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{e.amountHuman}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{e.memo ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Create `src/components/PlanReviewCard.tsx`**:

```tsx
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { getMint } from "@solana/spl-token"
import { useConnection } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"
import { Play } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { lamportsToSol, rawToHuman } from "@/lib/format"
import { validateDecimals } from "@/lib/parse"
import { fetchTreeState, splTreeKey } from "privacy-cash-sdk"
import type { Asset, ParsedFile } from "@/lib/types"

const SOL_DECIMALS = 9

export function PlanReviewCard({
  parsed,
  bps,
  vaultSolRaw,
  onRun,
  disabled,
}: {
  parsed: ParsedFile | null
  bps: number | null
  vaultSolRaw: bigint | null
  onRun: (asset: Asset) => void
  disabled: boolean
}) {
  const { connection } = useConnection()
  const [kind, setKind] = useState<"sol" | "spl">("sol")
  const [mint, setMint] = useState("")
  const [decimals, setDecimals] = useState<number | null>(null)
  const [mintError, setMintError] = useState<string | null>(null)

  const asset: Asset | null = useMemo(() => {
    if (kind === "sol") return { kind: "sol" }
    if (mint && decimals !== null) return { kind: "spl", mint, decimals }
    return null
  }, [kind, mint, decimals])

  const activeDecimals = kind === "sol" ? SOL_DECIMALS : decimals

  const decimalErrors =
    parsed && activeDecimals !== null ? validateDecimals(parsed.entries, activeDecimals) : []

  const resolveMint = async () => {
    setMintError(null)
    setDecimals(null)
    try {
      const m = new PublicKey(mint)
      const info = await getMint(connection, m)
      setDecimals(info.decimals)
      // Fail fast (spec: error matrix) if this mint has no initialized tree.
      try {
        await fetchTreeState(splTreeKey(m.toBase58()))
      } catch {
        setMintError(
          "this mint has no initialized merkle tree — ask the operator to initialize it (see README ops notes)",
        )
      }
    } catch (e) {
      setMintError(`cannot load mint: ${(e as Error).message}`)
    }
  }

  const totals = useMemo(() => {
    if (!parsed || activeDecimals === null || bps === null) return null
    // fee math preview only — full planning re-runs in the engine
    const nets = parsed.entries.map((e) => ({
      net: BigInt(
        (e.amountHuman.split(".")[0] || "0") +
          ((e.amountHuman.split(".")[1] ?? "").padEnd(activeDecimals, "0").slice(0, activeDecimals)),
      ),
    }))
    const totalNet = nets.reduce((s, n) => s + n.net, 0n)
    const totalFees = (totalNet * BigInt(bps) + 9_999n) / 10_000n
    return { totalNet, totalFees }
  }, [parsed, activeDecimals, bps])

  const vaultBig = vaultSolRaw ?? 0n
  const shortfall =
    totals && kind === "sol" && totals.totalNet + totals.totalFees > vaultBig
      ? totals.totalNet + totals.totalFees - vaultBig
      : 0n

  const canRun =
    !!parsed && bps !== null && !!asset && !mintError && decimalErrors.length === 0 && !disabled

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="size-4" /> Review &amp; run
        </CardTitle>
        <CardDescription>
          Vault funds are spent first. {shortfall > 0n ? "You will sign " : "No deposit needed — vault covers this run."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Asset</Label>
            <div className="flex gap-1 rounded-lg border p-0.5">
              {(["sol", "spl"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => { setKind(k); setDecimals(null) }}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                >
                  {k === "sol" ? "SOL" : "SPL token"}
                </button>
              ))}
              <Badge variant="secondary" className="ml-auto self-center">Shielded — v2</Badge>
            </div>
          </div>
          {kind === "spl" && (
            <div className="space-y-2">
              <Label htmlFor="mint">Mint</Label>
              <div className="flex gap-2">
                <Input id="mint" value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Mint pubkey" />
                <Button variant="outline" onClick={resolveMint} disabled={!mint}>Load</Button>
              </div>
              {decimals !== null && <p className="text-xs text-muted-foreground">decimals: {decimals}</p>}
              {mintError && <p className="text-xs text-destructive">{mintError}</p>}
            </div>
          )}
        </div>

        {totals && (
          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Employees receive</div>
              <div className="font-mono">
                {rawToHuman(totals.totalNet, activeDecimals!)}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Relayer fees (est.)</div>
              <div className="font-mono">{rawToHuman(totals.totalFees, activeDecimals!)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">
                {kind === "sol" ? "Deposit to sign" : "SPL vault needed"}
              </div>
              <div className="font-mono">
                {kind === "sol" ? rawToHuman(shortfall, SOL_DECIMALS) : "—"}
              </div>
            </div>
          </div>
        )}

        {decimalErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Amounts exceed this asset's decimals</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {decimalErrors.map((e, i) => <li key={i} className="font-mono text-xs">{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <Button
          className="w-full"
          size="lg"
          disabled={!canRun}
          onClick={() => {
            if (!asset) return
            if (kind === "spl" && mint && decimals !== null) {
              toast.info("First SPL run may ask for one extra one-time signature (lookup table setup).")
            }
            onRun(asset)
          }}
        >
          Run payroll
        </Button>
      </CardContent>
    </Card>
  )
}
```

Note: the review card's totals are a display estimate; the engine's `planRun` remains the source of truth for gross/shortfall at execution time.

- [ ] **Step 3: Verify build and commit**

Run: `bun run build` → PASS. (`bun run dev` — cards render with placeholder data.)

```bash
git add payroll
git commit -m "feat(payroll): upload card and plan review card"
```

---

### Task 9: RunProgressCard + HistoryCard + App wiring

**Files:**
- Create: `payroll/src/components/RunProgressCard.tsx`, `payroll/src/components/HistoryCard.tsx`
- Modify: `payroll/src/App.tsx`

**Interfaces:**
- Consumes: `engine.PayrollEngine/RunSnapshot/createEngine`, `usePayrollClient`, `store.listRuns/failedEntriesOf`, `history.downloadRun`.
- Produces: the complete user flow.

- [ ] **Step 1: Create `src/components/RunProgressCard.tsx`**:

```tsx
import { Ban, CheckCircle2, CircleDashed, ExternalLink, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { RunSnapshot } from "@/lib/engine"
import { shortHash } from "@/lib/format"
import type { EntryStatus, RunReceipt } from "@/lib/types"

const STATUS_LABEL: Record<EntryStatus, string> = {
  queued: "queued",
  proving: "proving",
  relayed: "relayed",
  confirmed: "confirmed",
  confirming: "confirming",
  failed: "failed",
}

/** Receipt rows store "sent"; display uses the engine vocabulary. */
function displayStatus(s: string): EntryStatus {
  return s === "sent" ? "confirmed" : (s as EntryStatus)
}

function Row({ status, address, memo, sig, error }: {
  status: EntryStatus
  address: string
  memo?: string
  sig?: string
  error?: string
}) {
  return (
    <tr className="border-t">
      <td className="px-3 py-1.5">
        {status === "confirmed" ? <CheckCircle2 className="size-4 text-green-600" />
          : status === "failed" ? <Ban className="size-4 text-destructive" />
          : status === "queued" ? <CircleDashed className="size-4 text-muted-foreground" />
          : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </td>
      <td className="px-3 py-1.5 font-mono">{shortHash(address, 6, 4)}</td>
      <td className="px-3 py-1.5 text-muted-foreground">{memo ?? ""}</td>
      <td className="px-3 py-1.5">
        <Badge variant={status === "failed" ? "destructive" : status === "confirmed" ? "default" : "secondary"}>
          {STATUS_LABEL[status]}
        </Badge>
      </td>
      <td className="px-3 py-1.5 text-right">
        {sig && (
          <a
            className="inline-flex items-center gap-1 font-mono text-xs underline"
            href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            {shortHash(sig, 6, 4)} <ExternalLink className="size-3" />
          </a>
        )}
        {error && <span className="ml-2 text-xs text-destructive" title={error}>{shortHash(error, 12, 8)}</span>}
      </td>
    </tr>
  )
}

export function RunProgressCard({
  snapshot,
  receipt,
  onCancel,
  onDone,
  onResumeFailed,
}: {
  snapshot: RunSnapshot | null
  receipt: RunReceipt | null
  onCancel: () => void
  onDone: () => void
  onResumeFailed: () => void
}) {
  if (!snapshot && !receipt) return null
  const rows = snapshot?.rows ?? receipt?.entries ?? []
  const done = receipt !== null
  const sent = rows.filter((r) => r.status === "confirmed" || r.status === "sent").length
  const pct = rows.length ? Math.round((sent / rows.length) * 100) : 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {done ? `Run ${receipt!.summary.sent}/${receipt!.summary.total} sent` : `Paying… ${sent}/${rows.length}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <table className="w-full text-xs">
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.address}
                status={displayStatus(r.status)}
                address={r.address}
                memo={r.memo}
                sig={r.txSignature}
                error={r.error}
              />
            ))}
          </tbody>
        </table>
        <div className="flex gap-2">
          {!done && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
          {done && (
            <>
              <Button onClick={onDone}>New run</Button>
              {receipt!.summary.failed > 0 && (
                <Button variant="outline" onClick={onResumeFailed}>
                  Resume failed ({receipt!.summary.failed})
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
```

Note: `RunSnapshot` lives in `@/lib/engine`; `RunReceipt` and `EntryStatus` in `@/lib/types` (imports above are final).

- [ ] **Step 2: Create `src/components/HistoryCard.tsx`**:

```tsx
import { useState } from "react"
import { Download, History } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { downloadRun } from "@/lib/history"
import { shortHash } from "@/lib/format"
import { listRuns } from "@/lib/store"
import type { RunReceipt } from "@/lib/types"

export function HistoryCard({ onResumeFailed }: { onResumeFailed: (r: RunReceipt) => void }) {
  const [runs, setRuns] = useState<RunReceipt[]>(() => listRuns())
  const [openId, setOpenId] = useState<string | null>(null)

  if (runs.length === 0) return null
  const reload = () => setRuns(listRuns())

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" /> Past runs
        </CardTitle>
        <CardDescription>Receipts live in this browser only; on-chain signatures are the source of truth.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.map((r) => (
          <div key={r.id} className="rounded-lg border">
            <button
              className="flex w-full items-center justify-between px-3 py-2 text-left text-xs"
              onClick={() => setOpenId(openId === r.id ? null : r.id)}
            >
              <span className="font-mono text-muted-foreground">
                {new Date(r.createdAt).toLocaleString()} · file {shortHash(r.fileHash, 6, 4)}
              </span>
              <span>
                {r.asset.kind === "sol" ? "SOL" : "SPL"} · {r.summary.sent}/{r.summary.total} sent
                {r.summary.failed > 0 && ` · ${r.summary.failed} failed`}
              </span>
            </button>
            {openId === r.id && (
              <div className="space-y-2 border-t px-3 py-2">
                {r.entries.map((e) => (
                  <div key={e.address} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono">{shortHash(e.address, 6, 4)} · {e.amountHuman}</span>
                    {e.txSignature ? (
                      <a
                        className="font-mono underline"
                        href={`https://explorer.solana.com/tx/${e.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortHash(e.txSignature, 6, 4)}
                      </a>
                    ) : (
                      <span className="text-destructive">{e.error ?? e.status}</span>
                    )}
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => downloadRun(r, "csv")}>
                    <Download className="mr-1 size-3" /> CSV
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadRun(r, "json")}>
                    <Download className="mr-1 size-3" /> JSON
                  </Button>
                  {r.summary.failed > 0 && (
                    <Button size="sm" variant="secondary" onClick={() => onResumeFailed(r)}>
                      Resume failed
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={reload}>Refresh</Button>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: Rewrite `src/App.tsx`** (full flow):

```tsx
import { useCallback, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"

import { HistoryCard } from "@/components/HistoryCard"
import { PlanReviewCard } from "@/components/PlanReviewCard"
import { RunProgressCard } from "@/components/RunProgressCard"
import { SettingsDrawer } from "@/components/SettingsDrawer"
import { UploadCard } from "@/components/UploadCard"
import { WalletBar } from "@/components/WalletBar"
import { useConnectWallet } from "@/components/WalletProvider"
import { usePayrollClient } from "@/hooks/usePayrollClient"
import { createEngine, type RunSnapshot } from "@/lib/engine"
import { failedEntriesOf, storageOk } from "@/lib/store"
import type { Asset, ParsedFile, RunReceipt } from "@/lib/types"

export default function App() {
  const { open: openModal } = useConnectWallet()
  const { publicKey } = useWallet()
  const { client, ready, busy, error, vaultSolRaw, bps, refreshVault } = usePayrollClient()
  const [storageWarn] = useState(() => !storageOk())

  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const engineRef = useRef<{ cancel: () => void } | null>(null)

  const startRun = useCallback(
    async (asset: Asset, entries = parsed?.entries, fileHash = parsed?.fileHash) => {
      if (!client || !entries || !fileHash || bps === null) return
      setReceipt(null)
      setSnapshot({ phase: "funding", rows: entries.map((e) => ({ ...e, status: "queued" as const, attempts: 0 })) })
      const engine = createEngine(client)
      engineRef.current = engine
      try {
        const r = await engine.run(
          { fileHash, asset, entries, bps, vaultRaw: vaultSolRaw ?? 0n },
          setSnapshot,
        )
        setReceipt(r)
        await refreshVault()
        if (r.summary.failed > 0) toast.warning(`${r.summary.failed} payout(s) failed — resume available`)
        else toast.success("Payroll run complete")
      } catch (e) {
        toast.error(`Run crashed: ${(e as Error).message}`)
        setSnapshot(null)
      }
    },
    [client, parsed, bps, vaultSolRaw, refreshVault],
  )

  const resumeFailed = useCallback(
    (r: RunReceipt) => {
      const entries = failedEntriesOf(r)
      if (!entries.length) return
      setParsed({ entries, fileHash: r.fileHash })
      startRun(r.asset, entries, r.fileHash)
    },
    [startRun],
  )

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Privacy Payroll</h1>
      <WalletBar vaultSolRaw={vaultSolRaw} relayerOk={bps !== null} onOpenSettings={() => setSettingsOpen(true)} />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {storageWarn && (
        <p className="text-sm text-muted-foreground">
          Browser storage is unavailable — runs will work but receipts won't persist.
        </p>
      )}

      {!publicKey ? (
        <button className="w-full rounded-lg border p-6 text-center" onClick={openModal}>
          Connect the treasury wallet to begin
        </button>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">Unlocking vault… (approve the signature request)</p>
      ) : (
        <>
          <UploadCard onParsed={setParsed} />
          <PlanReviewCard
            parsed={parsed}
            bps={bps}
            vaultSolRaw={vaultSolRaw}
            disabled={!ready}
            onRun={(asset) => startRun(asset)}
          />
          <RunProgressCard
            snapshot={snapshot}
            receipt={receipt}
            onCancel={() => engineRef.current?.cancel()}
            onDone={() => { setSnapshot(null); setReceipt(null); setParsed(null) }}
            onResumeFailed={() => receipt && resumeFailed(receipt)}
          />
        </>
      )}

      <HistoryCard onResumeFailed={resumeFailed} />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}
```

- [ ] **Step 4: Verify the whole flow compiles + tests green, commit**

Run: `bun run test && bun run build` → both PASS. Manual smoke: `bun run dev`, connect devnet wallet (phantom), paste a 1-row JSON, see the review card totals and the disabled "Run payroll" until an asset is resolvable.

```bash
git add payroll
git commit -m "feat(payroll): run progress, history, and full app wiring"
```

---

### Task 10: README + devnet E2E runbook

**Files:**
- Create: `payroll/README.md`

- [ ] **Step 1: Write `payroll/README.md`**:

````markdown
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
````

- [ ] **Step 2: Final verification sweep**

```bash
bun run test && bun run build && git status --short
```

Expected: tests green, build green, `git status` shows nothing staged beyond `payroll/` files; the two mobile files remain dirty and unstaged.

- [ ] **Step 3: Commit**

```bash
git add payroll
git commit -m "docs(payroll): readme with run instructions and devnet e2e runbook"
```

---

## Self-review notes (for the executor)

- Spec coverage: folder isolation (Tasks 1–10 create only `payroll/` files), JSON+CSV (T3), net-exact fees (T4), vault-first + single signature (T6), sequential relayed payouts + retries + resume (T6, T9), localStorage receipts + export + storage warning (T5, T9), settings overrides (T2, T7), disabled shielded toggle (T8), SPL-tree fail-fast (T8), README/runbook (T10).
- `sdk/dist` must exist for `file:../sdk` to resolve; if missing, run `bun run build` inside `sdk/` (build output only — no tracked-file changes).
