import { describe, expect, it } from "vitest";
import { parseTokenAmount } from "./payment";

describe("selected payment asset", () => {
  it("converts SOL and stablecoins using their own decimal precision", () => {
    expect(parseTokenAmount("0.45", "SOL")).toBe(450_000_000);
    expect(parseTokenAmount("0.45", "USDC")).toBe(450_000);
    expect(parseTokenAmount("1.000001", "USDT")).toBe(1_000_001);
    expect(() => parseTokenAmount("1.0000001", "USDC")).toThrow();
  });
});
