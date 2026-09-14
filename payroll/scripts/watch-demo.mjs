// Live demo balance watcher: watch every employee address from a payroll
// file (plus the relayer fee wallet and the shielded-tree leaf count) while a
// payroll run lands.
//
//   bun scripts/watch-demo.mjs                          # watch demo-payroll.csv
//   bun scripts/watch-demo.mjs --file my.csv --once     # single snapshot + deltas
//   bun scripts/watch-demo.mjs --treasury <pubkey>      # also track the treasury
//
// Baseline is the first snapshot; later rows show the change from baseline, so
// a payroll run paints green arrows as payouts land. --treasury tracks the
// company wallet; the leaf count is the "shielded notes landed" counter.
import { readFileSync } from "node:fs"
import path from "node:path"
import { Connection, PublicKey } from "@solana/web3.js"

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const FILE = argOf("--file", "demo-payroll.csv")
const TREASURY = argOf("--treasury", null)
const ONCE = args.includes("--once")
const INTERVAL = Number(argOf("--interval", "2000"))

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899"
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")
const TREE_KEY = process.env.TREE_KEY ?? "sol"

const connection = new Connection(RPC_URL, "confirmed")

function parsePayrollFile(raw) {
  const text = raw.trim()
  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : parsed.payments
    if (!Array.isArray(rows)) throw new Error("JSON file: expected an array or {payments:[...]}")
    return rows
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const header = lines[0].toLowerCase().split(",").map((h) => h.trim())
  const addrCol = header.indexOf("address")
  if (addrCol < 0) throw new Error("CSV file: first row must have an `address` column")
  const amtCol = header.indexOf("amount")
  return lines.slice(1).map((line) => {
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim())
    return { address: cols[addrCol], amount: Number(amtCol >= 0 ? cols[amtCol] : 0), memo: cols[header.indexOf("memo")] }
  })
}

const here = path.dirname(new URL(import.meta.url).pathname)
const rows = parsePayrollFile(readFileSync(path.resolve(here, "..", FILE), "utf8"))
const seen = new Set()
const employees = rows
  .filter((r) => {
    try {
      new PublicKey(r.address)
    } catch {
      return false
    }
    if (seen.has(r.address)) return false
    seen.add(r.address)
    return true
  })
  .map((r) => ({ label: `${r.address.slice(0, 4)}…${r.address.slice(-4)}`, address: r.address, want: r.amount }))

const relayerInfo = await fetch(`${BACKEND_URL}/api/relayer/info`).then((r) => r.json())
const relayerAddr = relayerInfo.fee_recipient

const tracked = [
  ...(TREASURY ? [{ label: "treasury", address: TREASURY, want: null }] : []),
  ...employees,
  { label: "relayer (fees)", address: relayerAddr, want: null },
]

const baseline = new Map()
async function balances() {
  const out = new Map()
  await Promise.all(
    tracked.map(async (t) => {
      out.set(t.address, await connection.getBalance(new PublicKey(t.address)))
    }),
  )
  return out
}

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const sol = (l) => (l / 1e9).toFixed(6)

function fmtDelta(now, base) {
  if (base === undefined || now === base) return dim("    ·            ")
  const d = now - base
  const s = `${d > 0 ? "▲" : "▼"} ${d > 0 ? "+" : "−"}${sol(Math.abs(d)).replace(/0+$/, "").replace(/\.$/, ".0")} SOL`
  return d > 0 ? green(bold(s.padEnd(17))) : red(bold(s.padEnd(17)))
}

async function leaves() {
  const r = await fetch(`${BACKEND_URL}/api/merkle/${TREE_KEY}`).then((x) => x.json())
  return r.next_leaf_index
}

let baselineDone = false
let lastLeaves = null
async function snapshot() {
  const [bals, leafCount] = await Promise.all([balances(), leaves()])
  if (!baselineDone) {
    for (const [addr, bal] of bals) baseline.set(addr, bal)
    lastLeaves = leafCount
    baselineDone = true
  }
  const line = "─".repeat(58)
  console.log(`\n${bold(` privacy-payroll watcher `)}${dim(new Date().toLocaleTimeString())}  ${dim(RPC_URL)}`)
  console.log(dim(` ${line}`))
  for (const t of tracked) {
    const bal = bals.get(t.address)
    const want = t.want != null ? dim(`  (file: ${t.want} SOL)`) : ""
    console.log(` ${t.label.padEnd(16)} ${sol(bal).padStart(12)} SOL  ${fmtDelta(bal, baseline.get(t.address))}${want}`)
  }
  console.log(dim(` ${line}`))
  const leafDelta = leafCount - lastLeaves
  const leafStr = `shielded leaves: ${bold(String(leafCount))}  ${leafDelta > 0 ? green(bold(`▲ +${leafDelta} new note${leafDelta > 1 ? "s" : ""}`)) : dim("·")}`
  console.log(` ${leafStr}`)
  lastLeaves = leafCount
}

console.log(bold(`\n watching ${employees.length} employee address(es) from ${FILE}`))
if (TREASURY) console.log(dim(` treasury: ${TREASURY}`))
await snapshot()
if (ONCE) {
  console.log(dim("\n baseline set — run again (no --once) or keep this process running to see deltas."))
  process.exit(0)
}
console.log(dim(" live — run the payroll in the browser; this updates every " + INTERVAL / 1000 + "s. Ctrl-C to stop.\n"))
setInterval(async () => {
  try {
    console.clear()
    await snapshot()
  } catch (e) {
    console.log(red(` poll failed: ${e.message}`))
  }
}, INTERVAL)
