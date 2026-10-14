// End-to-end payroll bench driver. Needs the local stack up (./run.sh:
// surfpool :8899, backend, payroll dev server :5174). Opens bench.html in
// headless Chrome, collects the run JSON, prints a stage summary and saves
// it under payroll/bench/results/.
//
//   bun payroll/bench/run-bench.mjs --rows 50 --lanes 8 [--workers 4 --mode mt]
//        [--backend http://localhost:8080] [--label baseline] [--app http://localhost:5174]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const here = path.dirname(new URL(import.meta.url).pathname)
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") && !(all[i - 1] === "--jsflags") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
)
const rows = Number(args.rows ?? 20)
// lanes default to the app's recommendation for this machine (recommendLanes)
const lanes = args.lanes ? Number(args.lanes) : "auto"
const app = args.app ?? "http://localhost:5174"
const label = args.label ?? "run"
const port = Number(args.port ?? 8978)
const timeoutMs = Number(args.timeout ?? 30 * 60_000)
// CHROME, else the newest chrome-headless-shell under ~/.cache/charon-browsers
// (bunx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/charon-browsers)
const chrome =
  process.env.CHROME ??
  (() => {
    const base = path.join(homedir(), ".cache/charon-browsers/chrome-headless-shell")
    const found = (existsSync(base) ? readdirSync(base) : [])
      .flatMap((v) => (statSync(path.join(base, v)).isDirectory() ? readdirSync(path.join(base, v)).map((d) => path.join(base, v, d, "chrome-headless-shell")) : []))
      .filter((f) => existsSync(f))
      .sort()
    if (!found.length) throw new Error(`no chrome-headless-shell under ${base} (set CHROME=...)`)
    return found.at(-1)
  })()
const recipientsFile = args.recipients ?? path.join(here, "../.local-recipients.json")
// the local registry file only exists on machines that enrolled wallets by hand;
// --csv runs (bench-kit) bring their own registered employees
const recipients = existsSync(recipientsFile) ? Object.keys(JSON.parse(readFileSync(recipientsFile, "utf8"))) : []
// --wallet path: a throwaway local-chain keypair (JSON byte array), created on first use
const walletKey = args.wallet
  ? (() => {
      try {
        return JSON.parse(readFileSync(args.wallet, "utf8"))
      } catch {
        const k = [...crypto.getRandomValues(new Uint8Array(32))]
        const { Keypair } = require("@solana/web3.js")
        const kp = Keypair.fromSeed(Uint8Array.from(k))
        writeFileSync(args.wallet, JSON.stringify([...kp.secretKey]))
        return [...kp.secretKey]
      }
    })()
  : null
const csvEntries = args.csv
  ? readFileSync(args.csv, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).map(([address, amountHuman]) => ({ address, amountHuman }))
  : null

const qs = new URLSearchParams({ rows, collector: `http://localhost:${port}` })
if (lanes !== "auto") qs.set("lanes", String(lanes))
for (const k of ["workers", "mode", "backend", "rpc", "amount", "prover", "proverToken", "tree", "exact"]) if (args[k]) qs.set(k, args[k])

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }
let resolveResult
let lastPrint = 0
const resultP = new Promise((r) => (resolveResult = r))
const server = Bun.serve({
  port,
  async fetch(req) {
    const u = new URL(req.url)
    if (req.method === "OPTIONS") return new Response(null, { headers: cors })
    if (u.pathname === "/recipients") return Response.json(recipients, { headers: cors })
    // --csv path: pay the file's exact rows (address,amount[,memo]) instead of a flat amount
    if (u.pathname === "/entries") return Response.json(csvEntries, { headers: cors })
    if (u.pathname === "/wallet") return Response.json(walletKey, { headers: cors })
    if (u.pathname === "/progress") {
      const line = await req.text()
      if (Date.now() - lastPrint > 5000) {
        lastPrint = Date.now()
        console.log(`  ${line}`)
      }
      return new Response("ok", { headers: cors })
    }
    if (u.pathname === "/result") {
      resolveResult(JSON.parse(await req.text()))
      return new Response("ok", { headers: cors })
    }
    return new Response("404", { status: 404, headers: cors })
  },
})

const profile = mkdtempSync(path.join(tmpdir(), "payroll-bench-"))
// --jsflags passes V8 flags, e.g. --jsflags=--experimental-wasm-wide-arithmetic
const jsFlags = args.jsflags ? [`--js-flags=${args.jsflags}`] : []
const proc = spawn(chrome, ["--headless", "--disable-gpu", ...jsFlags, `--user-data-dir=${profile}`, `${app}/bench.html?${qs}`], {
  stdio: "ignore",
})
const timer = setTimeout(() => resolveResult({ error: `timeout after ${timeoutMs}ms` }), timeoutMs)
const res = await resultP
clearTimeout(timer)
proc.kill()
server.stop()
rmSync(profile, { recursive: true, force: true })

const dir = path.join(here, "results")
mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${rows}r${lanes}l.json`)
writeFileSync(file, JSON.stringify({ label, ...res }, null, 2))
if (res.error) {
  console.error(`bench failed: ${res.error}`)
  process.exit(1)
}

const pct = (xs, p) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : "-"
}
const stage = (k) => res.perRow.map((r) => r.timing?.[k])
const s = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`)
console.log(`${label}: ${rows} rows, ${res.params?.lanes ?? lanes} lanes, prover ${res.prover.mode} ${res.prover.workers}w x${res.prover.threads}t${res.prover.wide ? " (wide-arithmetic build)" : ""}`)
console.log(`  wall ${s(res.wallMs)}  funding ${s(res.fundingMs)}  payouts ${s(res.payoutMs)}  ` +
  `(${(rows / (res.payoutMs / 1000)).toFixed(2)} rows/s)  sent ${res.sent} failed ${res.failed} confirming ${res.confirming} splits ${res.splits}`)
console.log(`  prover service avg ${res.prover.serviceMs}ms, avg incl queue ${res.prover.avgMs}ms, ${res.prover.proves} proofs`)
console.log("  stage        p50     p90    max   (ms)")
for (const k of ["queueMs", "reserveMs", "prepMs", "proveRelayMs", "confirmMs"]) {
  console.log(`  ${k.padEnd(12)} ${String(pct(stage(k), 50)).padStart(6)} ${String(pct(stage(k), 90)).padStart(7)} ${String(pct(stage(k), 100)).padStart(6)}`)
}
if (res.errors.length) console.log(`  errors: ${[...new Set(res.errors)].slice(0, 5).join(" | ")}`)
console.log(`  saved ${path.relative(process.cwd(), file)}`)
