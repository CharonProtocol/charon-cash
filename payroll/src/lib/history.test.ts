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
