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
  const calls = {
    deposits: [] as number[],
    withdraws: [] as Array<[number, string]>,
    transfers: [] as Array<[number, string]>,
    splMints: [] as string[],
    refreshes: 0,
  }
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
    transferNoteSOL: async (recipient: string, netLamports: number) => {
      const left = ctl.fails.get(recipient) ?? 0
      if (left > 0) {
        ctl.fails.set(recipient, left - 1)
        throw new Error("relayer 503")
      }
      calls.transfers.push([netLamports, recipient])
      return {
        signature: `NOTE-${recipient[0]}`,
        leafIndex: 50 + calls.transfers.length,
        commitment: `0xcommit${calls.transfers.length}`,
      }
    },
    transferNoteSPL: async (m: string, recipient: string, netRaw: number) => {
      calls.splMints.push(m)
      calls.transfers.push([netRaw, recipient])
      return {
        signature: `NOTE-${recipient[0]}`,
        leafIndex: 60 + calls.transfers.length,
        commitment: `0xcommitspl${calls.transfers.length}`,
      }
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

  it("shielded mode pays exact NET via transferNoteSOL and never withdraws", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    expect(calls.withdraws).toHaveLength(0)
    expect(calls.transfers).toHaveLength(3)
    // 1, 2, 3 SOL at 9 decimals: net is the exact file amount, not gross
    expect(calls.transfers.map((t) => t[0])).toEqual([1_000_000_000, 2_000_000_000, 3_000_000_000])
    expect(calls.transfers.map((t) => t[1])).toEqual(E.map((e) => e.address))
    expect(receipt.mode).toBe("shielded")
    expect(receipt.summary).toEqual({ sent: 3, failed: 0, total: 3 })
    expect(receipt.entries.every((e) => e.noteLeafIndex !== undefined)).toBe(true)
    expect(receipt.entries.every((e) => typeof e.noteCommitment === "string")).toBe(true)
    expect(receipt.entries.map((e) => e.noteLeafIndex)).toEqual([51, 52, 53])
  })

  it("shielded SPL pays NET via transferNoteSPL with the mint", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 18n,
        mode: "shielded",
        asset: { kind: "spl", mint: "Mint111111111111111111111111111111111111111", decimals: 6 },
      }),
    )
    expect(calls.withdraws).toHaveLength(0)
    expect(calls.transfers).toHaveLength(3)
    // 6 decimals: 1, 2, 3 tokens -> 1e6, 2e6, 3e6 raw
    expect(calls.transfers.map((t) => t[0])).toEqual([1_000_000, 2_000_000, 3_000_000])
    // every row must be paid on the run's mint, not a stale/default one
    expect(calls.splMints).toEqual(Array(3).fill("Mint111111111111111111111111111111111111111"))
    expect(receipt.mode).toBe("shielded")
    expect(receipt.entries.every((e) => e.noteLeafIndex !== undefined)).toBe(true)
  })

  it("shielded mode retries a failing note transfer like public mode", async () => {
    const { client, calls } = mockClient({ fails: new Map([["B".repeat(32), 2]]) })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    expect(receipt.entries[1].status).toBe("sent")
    expect(receipt.entries[1].attempts).toBe(3)
    expect(calls.transfers).toHaveLength(3)
  })

  it("shielded funding sizes the deposit with the fee floor", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    // 0.0005 SOL net: bps fee 5_000 floored to 10_000; vault empty so the
    // deposit = net + fee + margin = 500_000 + 10_000 + 10_000 (without the
    // floor the engine would under-deposit by 10_000 and the row would fail)
    await engine.run(
      req({
        entries: [{ address: "D".repeat(32), amountHuman: "0.0005" }],
        vaultRaw: 0n,
        mode: "shielded",
        minTransferFee: 10_000,
      }),
    )
    expect(calls.deposits).toEqual([520_000])
  })
})

// ---------------------------------------------------------------------------
// parallel lanes: reservation ledger + pinned inputs
// ---------------------------------------------------------------------------

function laneClient(ctl: {
  notes: Array<{ id: string; amount: bigint }>
  withdrawMs: number
  withdraws: Array<{ lamports: number; recipient: string; pins: string[] }>
}) {
  let changeSeq = 0
  const inFlight = new Set<string>()
  const refreshes = { n: 0 }
  const listNotes = () =>
    ctl.notes.map((n) => ({ id: n.id, amount: n.amount.toString(), blinding: n.id }))
  const client: EngineClient = {
    init: async () => {},
    unlock: async () => {},
    refreshNotes: async () => {
      refreshes.n++
    },
    depositSOL: async () => {
      throw new Error("lane tests pre-fund the vault")
    },
    depositSPL: async () => {
      throw new Error("lane tests pre-fund the vault")
    },
    withdrawSOL: async (lamports: number, recipient: string, opts) => {
      const pins = (opts?.inputNotes ?? []).map((p) => p.blinding)
      for (const b of pins) {
        if (inFlight.has(b)) throw new Error(`OVERLAP: ${b} pinned by two lanes`)
        inFlight.add(b)
      }
      try {
        await new Promise((r) => setTimeout(r, ctl.withdrawMs))
        let held = 0n
        for (const b of pins) {
          const i = ctl.notes.findIndex((n) => n.id === b)
          if (i < 0) throw new Error("pinned note vanished")
          held += ctl.notes[i].amount
          ctl.notes.splice(i, 1)
        }
        if (held < BigInt(lamports)) throw new Error(`pinned ${held} < gross ${lamports}`)
        const change = held - BigInt(lamports)
        if (change > 0n) ctl.notes.push({ id: `change${changeSeq}`, amount: change })
        changeSeq++
        ctl.withdraws.push({ lamports, recipient, pins })
        return { signature: `SIG-${recipient[0]}` }
      } finally {
        for (const b of pins) inFlight.delete(b)
      }
    },
    withdrawSPL: async () => {
      throw new Error("not used")
    },
    transferNoteSOL: async () => {
      throw new Error("not used")
    },
    transferNoteSPL: async () => {
      throw new Error("not used")
    },
  }
  return { client, listNotes, refreshes }
}

function laneDeps(client: EngineClient, listNotes: () => ReturnType<ReturnType<typeof laneClient>["listNotes"]>) {
  return {
    client,
    listNotes: () => listNotes(),
    waitUntilIndexed: async () => {},
    confirmSignature: async () => true,
    now: () => Date.now(),
    newId: () => "run1",
    // compress the 800ms reservation poll so handoffs stay fast in tests
    sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / 50)),
  }
}

describe("PayrollEngine lanes", () => {
  it("one big note feeds 8 rows through change-note handoffs with zero pin overlap", async () => {
    const notes = [{ id: "big", amount: 100n * 10n ** 9n }]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 12, withdraws })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: Array.from({ length: 8 }, (_, i) => ({
          address: String(i).repeat(32),
          amountHuman: "1",
        })),
      }),
    )
    expect(receipt.summary).toEqual({ sent: 8, failed: 0, total: 8 })
    expect(withdraws).toHaveLength(8)
    // every payout must have run on exactly the reserved note, one at a time
    expect(withdraws.every((w) => w.pins.length === 1)).toBe(true)
    const pinned = withdraws.flatMap((w) => w.pins)
    expect(new Set(pinned).size).toBe(pinned.length)
  })

  it("fails a row as insufficient when no note (or change note) can ever cover it", async () => {
    const notes = [{ id: "mid", amount: 6n * 10n ** 9n }]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 8, withdraws })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [
          { address: "A".repeat(32), amountHuman: "5" },
          { address: "B".repeat(32), amountHuman: "5" },
        ],
      }),
    )
    expect(receipt.entries[0].status).toBe("sent")
    expect(receipt.entries[1].status).toBe("failed")
    expect(receipt.entries[1].error).toMatch(/insufficient/)
    expect(withdraws).toHaveLength(1)
  })

  it("reserves a two-note pair when no single note covers the payout", async () => {
    const notes = [
      { id: "three", amount: 3n * 10n ** 9n },
      { id: "four", amount: 4n * 10n ** 9n },
    ]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [{ address: "A".repeat(32), amountHuman: "5" }],
      }),
    )
    expect(receipt.summary).toEqual({ sent: 1, failed: 0, total: 1 })
    expect(withdraws[0].pins.sort()).toEqual(["four", "three"])
  })

  it("cancel() with more rows than lanes marks never-started rows failed-cancelled", async () => {
    const notes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, amount: 10n ** 9n }))
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 15, withdraws })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const p = engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: Array.from({ length: 20 }, (_, i) => ({
          address: String(i).repeat(32),
          amountHuman: "0.5",
        })),
      }),
    )
    setTimeout(() => engine.cancel(), 30)
    const receipt = await p
    expect(receipt.summary.sent).toBe(withdraws.length)
    expect(receipt.summary.sent + receipt.summary.failed).toBe(20)
    const cancelled = receipt.entries.filter((e) => e.error === "cancelled")
    expect(cancelled.length).toBe(receipt.summary.failed)
    expect(cancelled.every((e) => e.status === "failed")).toBe(true)
  })
})
