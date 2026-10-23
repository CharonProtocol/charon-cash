import { describe, expect, it } from "vitest"
import { explorerAddressUrl, explorerTxUrl } from "./explorer"

describe("explorer links", () => {
  it("point at devnet with the backend /rpc as the RPC", () => {
    expect(explorerTxUrl("SIG")).toBe("https://explorer.solana.com/tx/SIG?cluster=devnet")
    expect(explorerAddressUrl("ADDR")).toBe("https://explorer.solana.com/account/ADDR?cluster=devnet")
  })
})
