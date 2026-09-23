import { describe, it, expect } from "bun:test"
import BN from "bn.js"
import { PublicKey } from "@solana/web3.js"

import {
  canRelay,
  minEconomicWithdrawal,
  transferFee,
  transferRecipient,
  withdrawalFee,
} from "../src/relay-policy"

/** Two nullifier accounts plus a transaction fee — what the relayer charges. */
const FLOOR = new BN(1_802_680)
const WALLET = new PublicKey("11111111111111111111111111111112")
const FEE_RECIPIENT = new PublicKey("SysvarC1ock11111111111111111111111111111111")

describe("canRelay", () => {
  it("relays by default", () => {
    expect(
      canRelay({ selfRelay: false, isSpl: false, splRelayAvailable: true }),
    ).toBe(true)
  })

  it("does not relay when the user asked to sign for themselves", () => {
    expect(
      canRelay({ selfRelay: true, isSpl: false, splRelayAvailable: true }),
    ).toBe(false)
  })

  it("does not relay SPL when the relayer has no lookup table", () => {
    expect(
      canRelay({ selfRelay: false, isSpl: true, splRelayAvailable: false }),
    ).toBe(false)
    // SOL still works on the same relayer: only SPL needs the table.
    expect(
      canRelay({ selfRelay: false, isSpl: false, splRelayAvailable: false }),
    ).toBe(true)
  })
})

describe("withdrawalFee", () => {
  it("charges the protocol rate when the amount is large enough to cover relaying", () => {
    // 100 SOL at 25bps = 0.25 SOL, far above the rent floor.
    const fee = withdrawalFee({
      grossLamports: new BN(100_000_000_000),
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: true,
    })
    expect(fee.toString()).toBe("250000000")
  })

  it("raises the fee to the relayer floor on small withdrawals", () => {
    // 0.1 SOL at 25bps is 250_000 lamports, well under the rent the relayer eats.
    const fee = withdrawalFee({
      grossLamports: new BN(100_000_000),
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: true,
    })
    expect(fee.eq(FLOOR)).toBe(true)
  })

  it("charges only the protocol rate when self-relaying, since the user pays rent directly", () => {
    const fee = withdrawalFee({
      grossLamports: new BN(100_000_000),
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: false,
    })
    expect(fee.toString()).toBe("250000")
  })

  it("rounds the protocol fee up, never down", () => {
    const fee = withdrawalFee({
      grossLamports: new BN(1),
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: new BN(0),
      relay: false,
    })
    expect(fee.toString()).toBe("1")
  })
})

describe("transferFee", () => {
  it("is free when self-signed, because validate_fee exempts ext_amount == 0", () => {
    expect(
      transferFee({ minRelayFeeLamports: FLOOR, relay: false }).isZero(),
    ).toBe(true)
  })

  it("pays the relayer floor when relayed", () => {
    expect(
      transferFee({ minRelayFeeLamports: FLOOR, relay: true }).eq(FLOOR),
    ).toBe(true)
  })
})

describe("transferRecipient", () => {
  it("never publishes the sender's wallet on a relayed transfer", () => {
    const recipient = transferRecipient({
      relay: true,
      wallet: WALLET,
      feeRecipient: FEE_RECIPIENT,
    })
    expect(recipient.equals(WALLET)).toBe(false)
    expect(recipient.equals(FEE_RECIPIENT)).toBe(true)
  })

  it("keeps the wallet when self-relaying, where it is already the fee payer", () => {
    const recipient = transferRecipient({
      relay: false,
      wallet: WALLET,
      feeRecipient: FEE_RECIPIENT,
    })
    expect(recipient.equals(WALLET)).toBe(true)
  })
})

describe("minEconomicWithdrawal", () => {
  it("is above the relayer floor, so the recipient always nets something", () => {
    const min = minEconomicWithdrawal({
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: true,
    })
    expect(min.gt(FLOOR)).toBe(true)

    const fee = withdrawalFee({
      grossLamports: min,
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: true,
    })
    expect(min.sub(fee).gtn(0)).toBe(true)
  })

  it("is tight: one lamport less leaves the recipient nothing", () => {
    const min = minEconomicWithdrawal({
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: true,
    })
    const justUnder = min.subn(1)
    const fee = withdrawalFee({
      grossLamports: justUnder,
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: true,
    })
    expect(justUnder.sub(fee).lten(0)).toBe(true)
  })

  it("imposes no minimum when self-relaying", () => {
    const min = minEconomicWithdrawal({
      withdrawalFeeRateBps: 25,
      minRelayFeeLamports: FLOOR,
      relay: false,
    })
    expect(min.toString()).toBe("1")
  })
})
