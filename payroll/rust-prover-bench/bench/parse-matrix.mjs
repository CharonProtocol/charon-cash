// Parse bench/results/*.log (+ native run JSONs) into one summary table.
//   bun parse-matrix.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const RES = new URL("./results/", import.meta.url).pathname
const rows = []

const num = (s) => Number(String(s).replace(/[^\d.]/g, ""))
const files = readdirSync(RES).filter((f) => f.endsWith(".log"))

for (const f of files) {
  const label = f.replace(".log", "")
  const text = readFileSync(join(RES, f), "utf8")
  if (label.startsWith("native-")) {
    const [_, r, p, w] = label.match(/^native-(\d+)r-(\d+)p(?:-arkp(\d+))?$/) ?? []
    // register + deposit lines from the log
    const reg = text.match(/registered in ([\d.]+)s/)?.[1]
    const dep = text.match(/(\d+) deposits done in ([\d.]+)s/)
    // detailed numbers live in the newest JSON written under results/<label>/
    const dir = join(RES, label)
    let s = null
    if (existsSync(dir)) {
      const runs = readdirSync(dir).filter((x) => x.endsWith(".json"))
      if (runs.length) s = JSON.parse(readFileSync(join(dir, runs[0]), "utf8")).summary
    }
    if (!s) { rows.push({ label, rows: r, lanes: p, ark_provers: w ?? null, failed: true }); continue }
    rows.push({
      engine: "native-arkworks", employees: Number(r), lanes: Number(p),
      ark_provers: w ? Number(w) : "def",
      register_s: reg ? num(reg) : null,
      deposit_s: dep ? num(dep[2]) : +(s.setupMs ? 0 : 0),
      setup_s: +(s.setupMs / 1000).toFixed(1),
      pay_s: +(s.payWallMs / 1000).toFixed(1),
      total_s: +(s.totalWallMs / 1000).toFixed(1),
      proves: s.proves,
      prove_avg_ms: s.proveTotalMs ? Math.round(s.proveTotalMs / s.proves) : null,
      prove_p50_ms: s.proveP50Ms,
      v1_txs: s.v1TxsSent,
      paid: s.employeesPaidByEvents,
      lane_failures: s.laneFailures,
      chain_ok: !!s.chainVerify?.nextIndexMatch && !!s.chainVerify?.rootInHistory,
    })
  } else {
    const [_, r, l, w] = label.match(/^wasm-(\d+)r-(\d+)l-(\d+)w$/) ?? []
    const total = text.match(/total wall: ([\d.]+)s/)?.[1]
    const proves = text.match(/proofs: (\d+) prove-bucket=([\d.]+)s avg=([\d.]+)ms max=([\d.]+)ms/)
    const sent = text.match(/sent=(\d+) failed=(\d+)/)
    const poolReady = text.match(/\[([\d.]+)s\] prover pool ready/)
    const funded = text.match(/\[([\d.]+)s\] treasurer/)
    const spot = text.match(/spot-check: (\d+)\/(\d+)/)
    rows.push({
      engine: "wasm-arkworks", employees: Number(r), lanes: Number(l), workers: Number(w),
      pool_ready_s: poolReady ? num(poolReady[1]) : null,
      funded_s: funded ? num(funded[1]) : null,
      total_s: total ? num(total) : null,
      proves: proves ? Number(proves[1]) : null,
      prove_bucket_s: proves ? num(proves[2]) : null,
      prove_avg_ms: proves ? num(proves[3]) : null,
      prove_max_ms: proves ? num(proves[4]) : null,
      rows_per_s: total ? +(Number(r) / num(total)).toFixed(2) : null,
      sent: sent ? Number(sent[1]) : null,
      failed: sent ? Number(sent[2]) : null,
      spot_ok: spot ? `${spot[1]}/${spot[2]}` : null,
    })
  }
}

// table
const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]
const width = (k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "-").length))
console.log(cols.map((k) => String(k).padEnd(width(k))).join("  "))
for (const r of rows) console.log(cols.map((k) => String(r[k] ?? "-").padEnd(width(k))).join("  "))

const { writeFileSync } = await import("node:fs")
writeFileSync(join(RES, "summary-table.tsv"), cols.join("\t") + "\n" + rows.map((r) => cols.map((k) => r[k] ?? "").join("\t")).join("\n"))
console.log(`\n${rows.length} configs -> results/summary-table.tsv`)
