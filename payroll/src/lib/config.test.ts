// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { config } from "./config"

describe("config", () => {
  beforeEach(() => localStorage.clear())

  it("returns defaults when nothing stored", () => {
    expect(config.get().backendUrl).toBe(
      "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
    )
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
  })

  it("persists overrides and survives re-read", () => {
    config.set({ backendUrl: "https://example.workers.dev" })
    expect(config.get().backendUrl).toBe("https://example.workers.dev")
    expect(config.get().rpcUrl).toBe("https://api.devnet.solana.com")
  })

  it("rejects empty values in set", () => {
    config.set({ backendUrl: "https://x.dev" })
    config.set({ backendUrl: "" })
    expect(config.get().backendUrl).toBe("https://x.dev")
  })
})

describe("cores override", () => {
  it("uses the Settings value when set, the browser's report otherwise", () => {
    config.set({ cores: 8 })
    expect(config.cores()).toBe(8)
    config.set({ cores: undefined })
    expect(config.cores()).toBe(navigator.hardwareConcurrency || 4)
  })
})
