import { Keypair } from "@solana/web3.js"
import { describe, expect, it } from "vitest"
import { parsePayrollFile, toRaw, validateDecimals } from "./parse"

// Random on-curve keys (hardcoded devnet keys fail the on-curve check once edited).
const ADDR = Keypair.generate().publicKey.toBase58()
const ADDR2 = Keypair.generate().publicKey.toBase58()

describe("parsePayrollFile (JSON)", () => {
  it("parses the { payments: [...] } shape", () => {
    const r = parsePayrollFile(
      JSON.stringify({ payments: [{ address: ADDR, amount: 1.5, memo: "Oct" }] }),
    )
    expect(r).toEqual({
      ok: true,
      entries: [{ address: ADDR, amountHuman: "1.5", memo: "Oct" }],
    })
  })

  it("parses a bare array and string amounts", () => {
    const r = parsePayrollFile(JSON.stringify([{ address: ADDR, amount: "0.000000001" }]))
    expect(r.ok && r.entries[0].amountHuman).toBe("0.000000001")
    expect(r.ok && r.entries[0].memo).toBeUndefined()
  })

  it("rejects invalid pubkeys with row numbers", () => {
    const r = parsePayrollFile(JSON.stringify([{ address: "notakey", amount: 1 }]))
    expect(!r.ok && r.errors[0]).toMatch(/row 1: address/)
  })

  it("rejects non-positive and non-finite amounts", () => {
    const r = parsePayrollFile(
      JSON.stringify([
        { address: ADDR, amount: 0 },
        { address: ADDR, amount: -3 },
        { address: ADDR, amount: "abc" },
      ]),
    )
    expect(!r.ok && r.errors).toHaveLength(4)
  })

  it("rejects exponent-form amounts with a row error", () => {
    const r = parsePayrollFile('{"payments":[{"address":"' + ADDR + '","amount":"1e-7"}]}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain("row 1")
  })

  it("rejects duplicate addresses citing both rows", () => {
    const r = parsePayrollFile(
      JSON.stringify([
        { address: ADDR, amount: 1 },
        { address: ADDR, amount: 2 },
      ]),
    )
    expect(!r.ok && r.errors[0]).toMatch(/row 2.*row 1|row 1.*row 2/)
  })

  it("rejects more than 200 entries", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      address: ADDR,
      amount: 1 + i * 0,
    }))
    const r = parsePayrollFile(JSON.stringify(many))
    expect(!r.ok && r.errors[0]).toMatch(/200/)
  })

  it("rejects malformed JSON and unknown shapes", () => {
    expect(!parsePayrollFile("{nope").ok)
    expect(!parsePayrollFile(JSON.stringify({ foo: 1 })).ok)
  })
})

describe("parsePayrollFile (CSV)", () => {
  it("parses header + rows, memo optional, quoted commas allowed", () => {
    const csv = `address,amount,memo\n${ADDR},1.5,"Doe, John"\n${ADDR2},2`
    const r = parsePayrollFile(csv)
    expect(r.ok && r.entries).toHaveLength(2)
    expect(r.ok && r.entries[0].memo).toBe("Doe, John")
    expect(r.ok && r.entries[1].memo).toBeUndefined()
  })

  it("accepts the two-column header too", () => {
    const r = parsePayrollFile(`address,amount\n${ADDR},1`)
    expect(r.ok && r.entries).toHaveLength(1)
  })

  it("requires the exact header", () => {
    expect(!parsePayrollFile("addr,amount\n" + ADDR + ",1").ok)
  })

  it("rejects a header-only CSV", () => {
    const r = parsePayrollFile("address,amount,memo")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(" ")).toContain("no payable rows")
  })
})

describe("validateDecimals + toRaw", () => {
  it("flags too many decimals", () => {
    const errs = validateDecimals([{ address: ADDR, amountHuman: "1.1234567890" }], 9)
    expect(errs[0]).toMatch(/decimals/)
  })

  it("toRaw is exact", () => {
    expect(toRaw("1.5", 9)).toBe(1_500_000_000n)
    expect(toRaw("0.000000001", 9)).toBe(1n)
    expect(toRaw("42", 6)).toBe(42_000_000n)
  })

  it("toRaw rejects garbage", () => {
    expect(() => toRaw("1.2.3", 9)).toThrow()
    expect(() => toRaw("-1", 9)).toThrow()
  })
})
