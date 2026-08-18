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
