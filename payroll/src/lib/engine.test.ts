import { describe, expect, it } from "vitest"
import { PublicKey } from "@solana/web3.js"
import { PayrollEngine, ADJUDICATE_POLLS, type EngineClient, type RunRequest, type RunSnapshot } from "./engine"
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
    fromScratches: 0,
  }
  const client: EngineClient = {
    init: async () => {},
    unlock: async () => {},
    refreshNotes: async (opts?: { fromScratch?: boolean }) => {
      calls.refreshes++
      if (opts?.fromScratch) calls.fromScratches++
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
  it("deposits the shortfall as one lumpsum, pays every entry, confirms, and writes a receipt", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    const snapshots: RunSnapshot[] = []
    const receipt = await engine.run(req(), (s) => snapshots.push({ ...s }))
    // one deposit for the full shortfall — a single signature funds the run
    expect(calls.deposits).toHaveLength(1)
    expect(BigInt(calls.deposits[0])).toBe(receipt.funding!.depositedRaw)
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

  it("adjudicates a thrown-after-broadcast shielded payout by its nullifier and confirms it", async () => {
    // The relayer accepted the broadcast, then the post-relay step threw with
    // the in-flight error. The pinned notes are spent on-chain — the engine
    // must resolve the real signature via signatureIfSpent instead of
    // retrying into the in-flight guard or freeing the notes for a re-spend.
    const { client: base } = mockClient({ fails: new Map() })
    const client: EngineClient = {
      ...base,
      transferNoteSOL: async (_recipient, _net, opts) => {
        await opts?.onSubmitted?.({})
        throw new Error(
          "a withdrawal for one of these nullifiers is already being processed",
        )
      },
      signatureIfSpent: async (blindings) => (blindings.length ? "LANDED-SIG" : null),
    }
    const notes = [1, 2, 3].map((i) => ({
      id: `n${i}`,
      amount: (2n * 10n ** 9n).toString(),
      blinding: `blind-${i}`,
    }))
    const engine = new PayrollEngine({
      client,
      listNotes: () => notes,
      waitUntilIndexed: async () => {},
      confirmSignature: async () => true,
      now: () => 1,
      newId: () => "run1",
      sleep: async () => {},
    })
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    expect(receipt.summary.sent).toBe(3)
    expect(receipt.entries.every((e) => e.status === "sent")).toBe(true)
    expect(receipt.entries.every((e) => e.txSignature === "LANDED-SIG")).toBe(true)
    expect(receipt.entries.every((e) => e.attempts === 1)).toBe(true)
    expect(receipt.entries.every((e) => e.error === undefined)).toBe(true)
  })

  it("releases pins and retries when adjudication finds nothing on-chain", async () => {
    const { client: base } = mockClient({ fails: new Map() })
    let polled = 0
    const client: EngineClient = {
      ...base,
      transferNoteSOL: async (_recipient, _net, opts) => {
        await opts?.onSubmitted?.({})
        throw new Error(
          "a withdrawal for one of these nullifiers is already being processed",
        )
      },
      signatureIfSpent: async () => {
        polled++
        return null
      },
    }
    const notes = [1, 2, 3].map((i) => ({
      id: `n${i}`,
      amount: (2n * 10n ** 9n).toString(),
      blinding: `blind-${i}`,
    }))
    const engine = new PayrollEngine({
      client,
      listNotes: () => notes,
      waitUntilIndexed: async () => {},
      confirmSignature: async () => true,
      now: () => 1,
      newId: () => "run1",
      sleep: async () => {},
    })
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    // not landed anywhere: the row fails after its attempts like before,
    // and adjudication polled its full window on every attempt (never
    // skipped silently)
    expect(receipt.entries.every((e) => e.status === "failed")).toBe(true)
    expect(receipt.entries.every((e) => e.attempts === 3)).toBe(true)
    expect(polled).toBe(9 * ADJUDICATE_POLLS)
  })

  it("keeps polling a thrown-after-broadcast payout (with indexer kicks) until the chain shows it", async () => {
    // The relayer holds retries for ~60s while the first submit is still
    // proving and the nullifier mirror syncs lazily — the row must wait the
    // window out, kicking the indexer, instead of reporting a failure for
    // money that lands a minute later.
    const { client: base } = mockClient({ fails: new Map() })
    let polls = 0
    let kicks = 0
    const client: EngineClient = {
      ...base,
      transferNoteSOL: async (_recipient, _net, opts) => {
        await opts?.onSubmitted?.({})
        throw new Error(
          "a withdrawal for one of these nullifiers is already being processed",
        )
      },
      signatureIfSpent: async () => {
        polls++
        return polls % 3 === 0 ? "POLL-SIG" : null
      },
    }
    const notes = [1, 2, 3].map((i) => ({
      id: `n${i}`,
      amount: (2n * 10n ** 9n).toString(),
      blinding: `blind-${i}`,
    }))
    // the kick gate is clock-based (min 20s between kicks), so drive a fake
    // clock through sleep — kicks then fire once per gate window while the
    // rows keep polling every 5s
    let clock = 0
    const engine = new PayrollEngine({
      client,
      listNotes: () => notes,
      waitUntilIndexed: async () => {},
      confirmSignature: async () => true,
      kickIndexer: async () => {
        kicks++
      },
      now: () => clock,
      newId: () => "run1",
      sleep: async (ms) => {
        clock += ms
      },
    })
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    expect(receipt.summary).toEqual({ sent: 3, failed: 0, total: 3 })
    expect(receipt.entries.every((e) => e.status === "sent")).toBe(true)
    expect(receipt.entries.every((e) => e.txSignature === "POLL-SIG")).toBe(true)
    expect(receipt.entries.every((e) => e.attempts === 1)).toBe(true)
    expect(kicks).toBeGreaterThanOrEqual(1)
  })

  it("re-syncs quickly when a pinned note vanishes before broadcast (never a full rescan)", async () => {
    // A landing lane's scan can drop a pinned blinding from the SDK's live
    // set between the ledger reload and the tx build. The engine must run a
    // fast regular sync so the retry re-resolves from a current set — a
    // fromScratch rescan here costs ~90s per hit and with more lanes the
    // heals themselves caused the next round of vanishes (the 5-lane run
    // collapsed to 7/min).
    const { client: base, calls } = mockClient({ fails: new Map() })
    let vanish = true
    let refreshes = 0
    let refreshesAtThrow = -1
    const client: EngineClient = {
      ...base,
      refreshNotes: async (opts?: { fromScratch?: boolean }) => {
        refreshes++
        return base.refreshNotes(opts)
      },
      transferNoteSOL: async (recipient, net, opts) => {
        if (vanish) {
          vanish = false
          refreshesAtThrow = refreshes
          throw new Error("pinned note not found in spendable set")
        }
        return base.transferNoteSOL(recipient, net, opts)
      },
    }
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    expect(receipt.summary).toEqual({ sent: 3, failed: 0, total: 3 })
    expect(receipt.entries.every((e) => e.status === "sent")).toBe(true)
    expect(receipt.entries.filter((e) => e.attempts === 2)).toHaveLength(1)
    // the heal ran after the throw, and it was a regular sync — no 90s rescan
    expect(refreshes).toBeGreaterThan(refreshesAtThrow)
    expect(calls.fromScratches).toBe(0)
  })

  it("cancel() stops between entries and leaves the rest failed-cancelled", async () => {
    const { client, calls } = mockClient({ fails: new Map(), slow: 10 })
    const engine = new PayrollEngine(deps(client))
    const p = engine.run(req({ vaultRaw: 10n ** 18n }))
    setTimeout(() => engine.cancel(), 15)
    const receipt = await p
    const statuses = receipt.entries.map((e) => e.status)
    // widest-first: the smallest row (entries[0]) is the one left unstarted
    expect(statuses[0]).toBe("failed")
    expect(receipt.entries.find((e) => e.error === "cancelled")?.status).toBe("failed")
    expect(calls.withdraws.length).toBeLessThan(3)
  })

  it("shielded mode pays exact NET via transferNoteSOL and never withdraws", async () => {
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    const receipt = await engine.run(req({ vaultRaw: 10n ** 18n, mode: "shielded" }))
    expect(calls.withdraws).toHaveLength(0)
    expect(calls.transfers).toHaveLength(3)
    // 1, 2, 3 SOL at 9 decimals: net is the exact file amount, not gross;
    // rows pay widest-first, so the 3 SOL row goes out first
    expect(calls.transfers.map((t) => t[0])).toEqual([3_000_000_000, 2_000_000_000, 1_000_000_000])
    expect(calls.transfers.map((t) => t[1])).toEqual([...E].reverse().map((e) => e.address))
    expect(receipt.mode).toBe("shielded")
    expect(receipt.summary).toEqual({ sent: 3, failed: 0, total: 3 })
    expect(receipt.entries.every((e) => e.noteLeafIndex !== undefined)).toBe(true)
    expect(receipt.entries.every((e) => typeof e.noteCommitment === "string")).toBe(true)
    expect(receipt.entries.map((e) => e.noteLeafIndex)).toEqual([53, 52, 51])
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
    // 6 decimals: 1, 2, 3 tokens -> 1e6, 2e6, 3e6 raw; widest row first
    expect(calls.transfers.map((t) => t[0])).toEqual([3_000_000, 2_000_000, 1_000_000])
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
    // one lumpsum covering net + floored fee + margin (520_000): a single
    // note big enough for the row — under-depositing would strand it
    expect(calls.deposits).toEqual([520_000])
  })

  it("funding budgets the split fan-out fees when the run will split", async () => {
    // 12 rows >= SPLIT_MIN_ROWS: the fan-out pays a relayer fee per split, so
    // the deposit must cover them or the last rows starve (the measured
    // 100-run failed its final row by 28,482 lamports exactly this way)
    const { client, calls } = mockClient({ fails: new Map() })
    const engine = new PayrollEngine(deps(client))
    await engine.run(
      req({
        entries: Array.from({ length: 12 }, (_, i) => ({
          address: String(i).repeat(32),
          amountHuman: "1",
        })),
        vaultRaw: 0n,
        mode: "shielded",
      }),
    )
    // replicate the spec: base = 12x(net+fee) + widest-row-fee margin, then
    // the halving-wave simulation down to the lane target (min(LANES=32,
    // 12 rows) = 12 → waves stop at 16 notes), padded x1.5 + 60k
    const S = 12n * (10n ** 9n + 10_000_000n) + 10_000_000n
    const feeOf = (x: bigint): bigint => (x * 100n + 9_999n) / 10_000n
    let notes = [S]
    let fees = 0n
    while (notes.length < Math.min(32, 12)) {
      const next: bigint[] = []
      for (const x of notes) {
        const pool = x - feeOf(x)
        const half = pool / 2n
        fees += feeOf(half)
        next.push(half, pool - half)
      }
      notes = next
    }
    expect(calls.deposits).toEqual([Number(S + (fees * 3n) / 2n + 60_000n)])
    expect(calls.deposits[0]).toBeGreaterThan(Number(S))
  })
})

// ---------------------------------------------------------------------------
// parallel lanes: reservation ledger + pinned inputs
// ---------------------------------------------------------------------------

function laneClient(ctl: {
  notes: Array<{ id: string; amount: bigint }>
  withdrawMs: number
  withdraws: Array<{ lamports: number; recipient: string; pins: string[] }>
  merges?: Array<{ net: bigint; pins: string[] }>
  splits?: Array<{ net: bigint; pins: string[] }>
  deposits?: number[]
}) {
  const SELF = "11111111111111111111111111111111"
  let changeSeq = 0
  const inFlight = new Set<string>()
  const refreshes = { n: 0 }
  const listNotes = () =>
    ctl.notes.map((n) => ({ id: n.id, amount: n.amount.toString(), blinding: n.id }))
  const payout = async (lamports: number, recipient: string, pins: string[]) => {
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
    } finally {
      for (const b of pins) inFlight.delete(b)
    }
  }
  const client: EngineClient = {
    init: async () => {},
    unlock: async () => {},
    publicKey: new PublicKey("11111111111111111111111111111111"),
    refreshNotes: async () => {
      refreshes.n++
    },
    // deposits mint a fresh spendable note — the contract the plan-time
    // funding and the mid-run top-up both rely on
    depositSOL: async (lamports: number) => {
      ctl.deposits?.push(lamports)
      ctl.notes.push({ id: `dep${changeSeq++}`, amount: BigInt(lamports) })
      return { signature: `DEP-${changeSeq}`, leafIndex: 70 + changeSeq, commitment: `0xd${changeSeq}` }
    },
    depositSPL: async (_m: string, raw: number) => {
      ctl.deposits?.push(raw)
      ctl.notes.push({ id: `dep${changeSeq++}`, amount: BigInt(raw) })
      return { signature: `DEP-${changeSeq}`, leafIndex: 70 + changeSeq, commitment: `0xd${changeSeq}` }
    },
    transferNoteSOL: async (recipient: string, netLamports: number, opts) => {
      const pins = (opts?.inputNotes ?? []).map((p) => p.blinding)
      await opts?.onSubmitted?.({})
      if (recipient === SELF) {
        if (pins.length !== 2 && pins.length !== 1)
          throw new Error("self transfer must pin one note (split) or two (merge)")
        let held = 0n
        for (const b of pins) {
          const i = ctl.notes.findIndex((n) => n.id === b)
          if (i < 0) throw new Error("pinned note vanished")
          held += ctl.notes[i].amount
          ctl.notes.splice(i, 1)
        }
        if (pins.length === 1) {
          // split: the recipient note and the change note both land in the
          // vault, so one note comes back as two
          const fee = (BigInt(netLamports) * 25n + 9_999n) / 10_000n
          const change = held - BigInt(netLamports) - fee
          ctl.splits?.push({ net: BigInt(netLamports), pins })
          if (change > 0n) ctl.notes.push({ id: `change${changeSeq}`, amount: change })
          changeSeq++
          ctl.notes.push({ id: `split${changeSeq}`, amount: BigInt(netLamports) })
          changeSeq++
          return { signature: `SPLIT-${changeSeq}`, leafIndex: 80 + changeSeq, commitment: `0xs${changeSeq}` }
        }
        const fee = (held * 25n + 9_999n) / 10_000n
        const merged = { id: `merged${changeSeq}`, amount: held - fee }
        changeSeq++
        ctl.notes.push(merged)
        ctl.merges?.push({ net: merged.amount, pins })
        return { signature: `MERGE-${changeSeq}`, leafIndex: 90 + changeSeq, commitment: `0xm${changeSeq}` }
      }
      await payout(netLamports, recipient, pins)
      return {
        signature: `NOTE-${recipient[0]}`,
        leafIndex: 50 + ctl.withdraws.length,
        commitment: `0xcommit${ctl.withdraws.length}`,
      }
    },
    transferNoteSPL: async () => {
      throw new Error("not used")
    },
    withdrawSOL: async (lamports: number, recipient: string, opts) => {
      const pins = (opts?.inputNotes ?? []).map((p) => p.blinding)
      await payout(lamports, recipient, pins)
      return { signature: `SIG-${recipient[0]}` }
    },
    withdrawSPL: async () => {
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
  it("pays a fragmented vault from one fresh deposit instead of merging fragments", async () => {
    // 28 fragments of 0.45 SOL cover the run's total (12.6 SOL) but neither
    // a single nor even a pair fits the widest row (1.01 SOL gross): paying
    // directly would merge fragments for every row (the measured ~4min per
    // 100 rows regardless of lanes). One fresh full deposit restores the
    // single-note fast path; fragments stay put.
    const notes = Array.from({ length: 28 }, (_, i) => ({ id: `f${i}`, amount: 450_000_000n }))
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const merges: Array<{ net: bigint; pins: string[] }> = []
    const splits: Array<{ net: bigint; pins: string[] }> = []
    const deposits: number[] = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, merges, splits, deposits })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        entries: Array.from({ length: 12 }, (_, i) => ({
          address: String.fromCharCode(97 + i).repeat(32),
          amountHuman: "1",
        })),
        vaultRaw: 0n,
        mode: "shielded",
        lanes: 8,
      }),
    )
    expect(receipt.summary).toEqual({ sent: 12, failed: 0, total: 12 })
    // one fresh full deposit (total + margin + fan-out budget) — not the
    // zero shortfall the covering-but-fragmented vault would suggest
    expect(deposits).toHaveLength(1)
    expect(deposits[0]).toBeGreaterThan(12_140_000_000)
    // the fan-out ran from the fresh note, and merge chains stayed rare
    expect(splits.length).toBeGreaterThanOrEqual(2)
    expect(merges.length).toBeLessThanOrEqual(3)
  })

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

  it("a lane's claimed change note funds the next row with no refresh in between", async () => {
    // The A5 handoff: row 1's payout mints a change note that row 2 (same
    // lane) reserves through the lane claim, made spendable by the
    // background resolveChangeNote — not by any refreshNotes. The refresh
    // mock below is deliberately a no-op: it cannot materialize the note,
    // so this test fails if the handoff ever regresses to a scan detour.
    const notes: Array<{ id: string; amount: bigint; blinding: string }> = [
      { id: "n1", amount: 3n * 10n ** 9n, blinding: "b-n1" },
    ]
    let resolved = 0
    const withdraws: string[] = []
    const client: EngineClient = {
      init: async () => {},
      unlock: async () => {},
      publicKey: new PublicKey("11111111111111111111111111111111"),
      refreshNotes: async () => {},
      depositSOL: async () => {
        throw new Error("no deposits expected")
      },
      depositSPL: async () => {
        throw new Error("no deposits expected")
      },
      withdrawSOL: async (lamports, _recipient, opts) => {
        const pins = (opts?.inputNotes ?? []).map((p) => p.blinding)
        if (pins.length !== 1) throw new Error(`expected 1 pin, got ${pins.length}`)
        const i = notes.findIndex((n) => n.blinding === pins[0])
        if (i < 0) throw new Error(`pinned note ${pins[0]} is not spendable`)
        const held = notes[i].amount
        if (held < BigInt(lamports)) throw new Error("pin smaller than gross")
        notes.splice(i, 1)
        withdraws.push(pins[0])
        const change = held - BigInt(lamports)
        // real SDK: the change note is saved pending (index is a guess) and
        // excluded from unspentNotes until resolveChangeNote pins the leaf
        if (change > 0n) {
          return {
            signature: "SIG-1",
            changeNote: { amount: change.toString(), blinding: "b-chg", index: 99 },
          }
        }
        return { signature: "SIG-2" }
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
      resolveChangeNote: async (_tree, _mint, change) => {
        resolved++
        // indexer saw the leaf: the note becomes spendable at its true index
        notes.push({ id: `chg-${change.blinding}`, amount: BigInt(change.amount), blinding: change.blinding })
      },
    }
    const engine = new PayrollEngine(
      laneDeps(client, () =>
        notes.map((n) => ({ id: n.id, amount: n.amount.toString(), blinding: n.blinding })),
      ),
    )
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 19n,
        entries: [
          { address: "A".repeat(32), amountHuman: "1" },
          { address: "B".repeat(32), amountHuman: "1" },
        ],
        lanes: 1,
      }),
    )
    expect(receipt.summary).toEqual({ sent: 2, failed: 0, total: 2 })
    // row 2 spent row 1's change note — the claimed blinding, no refresh
    expect(withdraws).toEqual(["b-n1", "b-chg"])
    // each payout that minted change fired exactly one background resolve
    expect(resolved).toBe(2)
  })

  it("tops the verified vault up at funding when the notes cannot cover the run", async () => {
    // 6 SOL of notes vs two 5 SOL rows: the verified balance (not the
    // caller's optimistic estimate) shows the gap, so funding deposits the
    // difference and both rows pay — trusting the raw estimate instead is
    // what dry-killed the second row in the measured run
    const notes = [{ id: "mid", amount: 6n * 10n ** 9n }]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const deposits: number[] = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 8, withdraws, deposits })
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
    expect(receipt.summary).toEqual({ sent: 2, failed: 0, total: 2 })
    expect(withdraws).toHaveLength(2)
    expect(deposits).toHaveLength(1)
    expect(deposits[0]).toBeGreaterThan(4n * 10n ** 9n)
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

  it("merges fragments into a fresh note when no pair covers the row", async () => {
    // 3 + 1 + 1 SOL: the total covers a 4.5 SOL payout but the widest pair is
    // 4 SOL < 4.51125 gross — the engine must merge two fragments to self,
    // then pay from the merged note + leftover
    const notes = [
      { id: "three", amount: 3n * 10n ** 9n },
      { id: "one", amount: 1n * 10n ** 9n },
      { id: "oneb", amount: 1n * 10n ** 9n },
    ]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const merges: Array<{ net: bigint; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, merges })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [{ address: "A".repeat(32), amountHuman: "4.5" }],
      }),
    )
    expect(receipt.summary).toEqual({ sent: 1, failed: 0, total: 1 })
    expect(merges).toHaveLength(1)
    expect(merges[0].pins.sort()).toEqual(["one", "three"])
    expect(withdraws).toHaveLength(1)
  })

  it("chains merges across 4+ equal fragments until a pair fits", async () => {
    // 1+1+1+1 SOL vs a 3.5 SOL row: no pair covers it, so the engine merges
    // the two largest repeatedly (1+1 -> ~2, then ~2+1 -> ~3) until the merged
    // note + a leftover fragment fit the 2-input circuit
    const notes = Array.from({ length: 4 }, (_, i) => ({ id: `frag${i}`, amount: 1n * 10n ** 9n }))
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const merges: Array<{ net: bigint; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, merges })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [{ address: "A".repeat(32), amountHuman: "3.5" }],
      }),
    )
    expect(receipt.summary).toEqual({ sent: 1, failed: 0, total: 1 })
    expect(merges).toHaveLength(2)
    expect(withdraws).toHaveLength(1)
  })

  it("recovers a heavily fragmented vault across several rows (6 fragments, 2 payouts)", async () => {
    const notes = Array.from({ length: 6 }, (_, i) => ({ id: `frag${i}`, amount: 1n * 10n ** 9n }))
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const merges: Array<{ net: bigint; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, merges })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [
          { address: "A".repeat(32), amountHuman: "3.5" },
          { address: "B".repeat(32), amountHuman: "2" },
        ],
      }),
    )
    expect(receipt.summary).toEqual({ sent: 2, failed: 0, total: 2 })
    expect(merges.length).toBeGreaterThanOrEqual(2)
    expect(withdraws).toHaveLength(2)
  })

  it("rescues an underfunded vault with deposits and never merges what it cannot afford", async () => {
    // 1 SOL of notes vs a 5 SOL row: merging is pointless while the total
    // (even after the funding top-up) first cannot cover the row — the engine
    // skips the merge chain, tops the vault with one shared deposit, and pays
    const notes = [{ id: "mid", amount: 1n * 10n ** 9n }]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const merges: Array<{ net: bigint; pins: string[] }> = []
    const deposits: number[] = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, merges, deposits })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [{ address: "A".repeat(32), amountHuman: "5" }],
      }),
    )
    expect(receipt.entries[0].status).toBe("sent")
    expect(merges).toHaveLength(0)
    expect(withdraws).toHaveLength(1)
    // funding tops the vault to the run total, and the top note + residual
    // then pair-cover the row — no mid-run top-up needed at this size
    expect(deposits).toHaveLength(1)
  })

  it("still fails honestly when the top-up deposit is rejected", async () => {
    // The measured run's terminal state: funding sizes slightly short
    // (3.03 SOL of notes vs a 3.04 SOL need), two rows pay, the third hits a
    // dry vault — and when the wallet refuses the one top-up deposit, that
    // row must fail with the honest balance error instead of hanging or
    // lying. The first deposit call is the funding signature; every later
    // call is the mid-run top-up being rejected.
    let idc = 0
    let leaf = 40
    const mk = (amount: bigint) => ({ id: `n${++idc}`, amount: amount.toString(), blinding: `b${idc}` })
    const notesArr = [mk(1050n * 10n ** 6n), mk(1050n * 10n ** 6n), mk(930n * 10n ** 6n)]
    let funding = 0
    let rejections = 0
    const { client: base } = mockClient({ fails: new Map() })
    const feeOf = (x: bigint) => (x * 100n) / 10_000n
    const client: EngineClient = {
      ...base,
      publicKey: new PublicKey("11111111111111111111111111111111"),
      refreshNotes: async () => {},
      depositSOL: async () => {
        if (funding++ === 0) return { signature: "FUND", leafIndex: 39 }
        rejections++
        throw new Error("user rejected the top-up")
      },
      transferNoteSOL: async (_recipient, netLamports, opts) => {
        const amt = BigInt(netLamports)
        const b = opts?.inputNotes?.[0]?.blinding
        const i = notesArr.findIndex((n) => n.blinding === b)
        if (i < 0) throw new Error("mock: pinned input not found")
        const input = BigInt(notesArr[i].amount)
        notesArr.splice(i, 1)
        const change = input - amt - feeOf(amt)
        if (change > 0n) notesArr.push(mk(change))
        return { signature: `S${++leaf}`, leafIndex: leaf, commitment: `c${leaf}` }
      },
    }
    const engine = new PayrollEngine({
      client,
      listNotes: () => notesArr,
      waitUntilIndexed: async () => {},
      confirmSignature: async () => true,
      now: () => 1,
      newId: () => "run1",
      sleep: async () => {},
    })
    const receipt = await engine.run(req({ vaultRaw: 0n, mode: "shielded" }))
    // 1 funding signature + 1 rejected mid-run top-up
    expect(funding).toBe(2)
    expect(receipt.entries[0].status).toBe("sent")
    expect(receipt.entries[1].status).toBe("sent")
    expect(receipt.entries[2].status).toBe("failed")
    expect(receipt.entries[2].error).toMatch(/insufficient/)
    expect(rejections).toBe(1)
  })

  it("splits the funding note 1->2->4->8 before paying so lanes stop serializing", async () => {
    // one big note + 12 rows: without the fan-out every payout queues on the
    // same change chain; the engine splits it to lane width first, and every
    // split half stays far above the widest row so no merge ever follows
    const notes = [{ id: "big", amount: 100n * 10n ** 9n }]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const splits: Array<{ net: bigint; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, splits })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: Array.from({ length: 12 }, (_, i) => ({
          address: String(i).repeat(32),
          amountHuman: "1",
        })),
      }),
    )
    // the fan-out runs several halving waves to lane width; with the
    // fresh-deposit fast path the deposit note joins the big note as a
    // second seed, so the exact wave count is one fewer than single-seed
    expect(splits.length).toBeGreaterThanOrEqual(5)
    expect(splits.every((s) => s.pins.length === 1)).toBe(true)
    expect(receipt.splits).toBe(splits.length)
    expect(receipt.summary).toEqual({ sent: 12, failed: 0, total: 12 })
    // payouts still ran on distinct pins — no note ever fed two lanes
    const pinned = withdraws.flatMap((w) => w.pins)
    expect(new Set(pinned).size).toBe(pinned.length)
  })

  it("skips the split fan-out for short runs (below the 10-row threshold)", async () => {
    const notes = [{ id: "big", amount: 100n * 10n ** 9n }]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const splits: Array<{ net: bigint; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, splits })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: Array.from({ length: 9 }, (_, i) => ({
          address: String(i).repeat(32),
          amountHuman: "1",
        })),
      }),
    )
    expect(splits).toHaveLength(0)
    expect(receipt.splits).toBeUndefined()
    expect(receipt.summary).toEqual({ sent: 9, failed: 0, total: 9 })
  })

  it("does not count leftover dust toward the lane target (the 2-lane 100-run bug)", async () => {
    // six tiny notes from a previous run sat next to the funding note: the
    // fan-out must ignore them when counting lanes, or it stops one split in
    // and every payout serializes through a single change chain
    const notes = [
      { id: "big", amount: 100n * 10n ** 9n },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `dust${i}`,
        amount: 150_000n + BigInt(i) * 1_000n,
      })),
    ]
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const splits: Array<{ net: bigint; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws, splits })
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: Array.from({ length: 12 }, (_, i) => ({
          address: String(i).repeat(32),
          amountHuman: "1",
        })),
      }),
    )
    // dust inflates the naive note count to 7, one short of target: the fix
    // still splits the funding note all the way to lane width (the fresh
    // deposit joins as a second seed, so one halving wave fewer)
    expect(splits.length).toBeGreaterThanOrEqual(5)
    expect(receipt.splits).toBe(splits.length)
    expect(receipt.summary).toEqual({ sent: 12, failed: 0, total: 12 })
    const pinned = withdraws.flatMap((w) => w.pins)
    expect(new Set(pinned).size).toBe(pinned.length)
  })

  it("retries a pre-broadcast pin miss instead of declaring the payout landed", async () => {
    // a concurrent scan can make a pinned note temporarily invisible; that
    // throw happens BEFORE the relay handoff, so the row must retry — not
    // be written off as "unconfirmed after broadcast" (the third 100-run
    // lost 9 rows to exactly that)
    const notes = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, amount: 3n * 10n ** 9n }))
    const withdraws: Array<{ lamports: number; recipient: string; pins: string[] }> = []
    const { client, listNotes } = laneClient({ notes, withdrawMs: 5, withdraws })
    const inner = client.transferNoteSOL.bind(client)
    let threw = false
    client.transferNoteSOL = async (recipient, net, opts) => {
      if (!threw) {
        threw = true
        throw new Error("pinned note not found in spendable set")
      }
      return inner(recipient, net, opts)
    }
    const engine = new PayrollEngine(laneDeps(client, listNotes))
    const receipt = await engine.run(
      req({
        vaultRaw: 10n ** 20n,
        entries: [{ address: "a".repeat(32), amountHuman: "1" }],
      }),
    )
    expect(receipt.summary).toEqual({ sent: 1, failed: 0, total: 1 })
    expect(withdraws).toHaveLength(1)
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
