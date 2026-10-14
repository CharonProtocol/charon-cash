// Write the shareable result file: machine info + each run's timing, prover
// shape and on-chain note verification.
//   bun bench-kit/summarize.ts <out.json> '<machine json>' <result.json|verify.json>...
import { readFileSync, writeFileSync } from "node:fs"

const [out, machine, ...pairs] = process.argv.slice(2)
const runs = pairs.map((pair) => {
  const [resultFile, verifyFile] = pair.split("|")
  const r = JSON.parse(readFileSync(resultFile, "utf8"))
  let v: Record<string, unknown> = {}
  try {
    v = JSON.parse(readFileSync(verifyFile, "utf8"))
  } catch {
    /* verification output missing: reported as such */
  }
  // distinct failure reasons, most common first, so a failed run explains itself
  const counts = new Map<string, number>()
  for (const row of r.perRow ?? []) {
    if (row.status === "sent" || !row.error) continue
    const key = String(row.error).slice(0, 400)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const errors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([error, rows]) => ({ rows, error }))
  return {
    label: r.label,
    at: r.at,
    rows: r.params.rows,
    lanes: r.params.lanes,
    cores: r.params.cores,
    wallSec: r.wallMs / 1000,
    fundingSec: r.fundingMs / 1000,
    payoutsSec: r.payoutMs / 1000,
    sent: r.sent,
    failed: r.failed,
    proofs: r.prover.proves,
    prover: {
      mode: r.prover.mode,
      workers: r.prover.workers,
      threads: r.prover.threads,
      wide: !!r.prover.wide,
      proofSec: r.prover.serviceMs / 1000,
    },
    verified: v,
    errors,
  }
})
writeFileSync(out, JSON.stringify({ machine: JSON.parse(machine), runs }, null, 2) + "\n")
for (const r of runs) {
  const v = r.verified as { allChecksPassed?: number; employees?: number }
  console.log(
    `    ${r.label}: ${r.rows} payouts in ${r.wallSec.toFixed(1)}s on ${r.lanes} lanes ` +
      `(${r.prover.workers} prover workers, ${r.prover.proofSec.toFixed(2)}s/proof) — ` +
      `${r.sent} sent, ${r.failed} failed, notes verified ${v.allChecksPassed ?? "?"}/${v.employees ?? "?"}`,
  )
  for (const e of r.errors) console.log(`      ✗ ${e.rows} rows: ${e.error}`)
  // a verification miss names its reason (no note found, amount, commitment, spent)
  const problems = (r.verified as { problems?: string[] }).problems ?? []
  for (const p of problems.slice(0, 3)) console.log(`      ✗ verify: ${p}`)
  if (problems.length > 3) console.log(`      … ${problems.length - 3} more in the result file`)
}
