// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { config } from "./config"

describe("config", () => {
  beforeEach(() => {
    localStorage.clear()
    config.set({ backendUrl: "https://backend.charon.cash", rpcUrl: "https://api.devnet.solana.com", cores: undefined })
  })

  it("defaults to the devnet backend and RPC", () => {
    expect(config.get().backendUrl).toBe("https://backend.charon.cash")
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
  })

  it("ignores settings an older build saved (no Settings screen any more)", () => {
    localStorage.setItem(
      "payroll:settings:v1",
      JSON.stringify({ backendUrl: "http://127.0.0.1:8080", rpcUrl: "http://127.0.0.1:8899" }),
    )
    expect(config.get().backendUrl).toBe("https://backend.charon.cash")
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
  })

  it("takes page-only overrides without persisting them", () => {
    config.set({ backendUrl: "https://example.workers.dev" })
    expect(config.get().backendUrl).toBe("https://example.workers.dev")
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
    expect(localStorage.getItem("payroll:settings:v1")).toBeNull()
  })

  it("rejects empty values in set", () => {
    config.set({ backendUrl: "https://x.dev" })
    config.set({ backendUrl: "" })
    expect(config.get().backendUrl).toBe("https://x.dev")
  })
})

describe("cores override", () => {
  it("uses an override when set, the browser's report otherwise", () => {
    config.set({ cores: 8 })
    expect(config.cores()).toBe(8)
    config.set({ cores: undefined })
    expect(config.cores()).toBe(navigator.hardwareConcurrency || 4)
  })
})
