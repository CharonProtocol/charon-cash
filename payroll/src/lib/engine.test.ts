import { describe, expect, it } from "vitest"
import { PayrollEngine, type EngineClient, type RunRequest, type RunSnapshot } from "./engine"
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
      return { signature: "DEP", leafIndex: 41 }
    },
    depositSPL: async (_m: string, raw: number) => {
      calls.deposits.push(raw)
      return { signature: "DEP", leafIndex: 41 }
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
    const snapshots: RunSnapshot[] = []
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
