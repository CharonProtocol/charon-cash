import { beforeEach, describe, expect, it } from "vitest"

import {
  addManualTeam,
  adoptRuns,
  adoptTeam,
  exportTeamDoc,
  listManualTeam,
  listRuns,
  removeManualTeam,
  saveRun,
} from "./store"
import type { RunReceipt } from "./types"

const receipt = (id: string, createdAt: number): RunReceipt => ({
  id,
  createdAt,
  fileHash: `hash-${id}`,
  asset: { kind: "sol" },
  mode: "shielded",
  totalPlanned: 1500000000n,
  entries: [
    { address: "7FdDKbyQgVyFG6dmKQfgvSSTfFMSjcMZA1qfbSbfSDVi", amountHuman: "1.5", status: "sent", txSignature: "sig", attempts: 1 },
  ],
  summary: { sent: 1, failed: 0, total: 1 },
  funding: { depositedRaw: 2000000000n, txSignature: "fund-tx" },
  startedAt: createdAt,
  finishedAt: createdAt + 1000,
})

/** A remote doc as it travels over the wire — bigints are strings. */
const wire = (id: string, createdAt: number): unknown => ({
  ...receipt(id, createdAt),
  totalPlanned: "1500000000",
  funding: { depositedRaw: "2000000000", txSignature: "fund-tx" },
})

beforeEach(() => {
  localStorage.clear()
})

describe("run ledger sync", () => {
  it("adopts a remote run the local store has not seen", () => {
    expect(adoptRuns([wire("r1", 100)])).toBe(true)
    expect(listRuns().map((r) => r.id)).toEqual(["r1"])
    expect(listRuns()[0].totalPlanned).toBe(1500000000n)
  })

  it("union-merges by id and keeps the newer createdAt on conflict", () => {
    saveRun(receipt("r1", 100))
    adoptRuns([wire("r1", 200), wire("r2", 50)])
    const ids = listRuns().map((r) => r.id)
    expect(ids).toContain("r2")
    expect(listRuns().find((r) => r.id === "r1")?.createdAt).toBe(200)
  })

  it("ignores malformed remote docs", () => {
    expect(adoptRuns(null)).toBe(false)
    expect(adoptRuns("nope")).toBe(false)
    expect(adoptRuns([{ nope: true }, { id: 42 }])).toBe(false)
    expect(listRuns()).toEqual([])
  })
})

describe("team roster sync", () => {
  const addr = "7FdDKbyQgVyFG6dmKQfgvSSTfFMSjcMZA1qfbSbfSDVi"

  it("adopts remote entries and removal tombstones", () => {
    adoptTeam({ entries: [{ address: addr, amountHuman: "0", memo: "Erin" }], removed: [] })
    expect(listManualTeam()).toHaveLength(1)

    // another device removed the teammate — the tombstone must win
    adoptTeam({ entries: [{ address: addr, amountHuman: "0", memo: "Erin" }], removed: [addr] })
    expect(listManualTeam()).toHaveLength(0)
  })

  it("a local delete is not resurrected by the remote roster", () => {
    addManualTeam({ address: addr, amountHuman: "0" })
    removeManualTeam(addr)
    adoptTeam({ entries: [{ address: addr, amountHuman: "0" }], removed: [] })
    expect(listManualTeam()).toHaveLength(0)
  })

  it("re-adding a removed teammate clears the tombstone and sticks", () => {
    addManualTeam({ address: addr, amountHuman: "0" })
    removeManualTeam(addr)
    addManualTeam({ address: addr, amountHuman: "0", memo: "Back" })
    expect(listManualTeam()).toHaveLength(1)
    // and the exported doc no longer tombstones them
    expect(exportTeamDoc()).toEqual({ entries: [{ address: addr, amountHuman: "0", memo: "Back" }], removed: [] })
  })

  it("exported docs round-trip through adoptTeam", () => {
    addManualTeam([{ address: addr, amountHuman: "0", memo: "A" }, { address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", amountHuman: "0", memo: "B" }])
    removeManualTeam("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")
    const doc = JSON.parse(JSON.stringify(exportTeamDoc()))
    localStorage.clear()
    expect(adoptTeam(doc)).toBe(true)
    expect(listManualTeam().map((m) => m.memo)).toEqual(["A"])
  })
})
