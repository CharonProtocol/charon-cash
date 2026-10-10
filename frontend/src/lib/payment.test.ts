import { describe, expect, it } from "vitest";
import { isSolanaAddress, parseTokenAmount } from "./payment";

describe("selected payment asset", () => {
  it("converts SOL and stablecoins using their own decimal precision", () => {
    expect(parseTokenAmount("0.45", "SOL")).toBe(450_000_000);
    expect(parseTokenAmount("0.45", "USDC")).toBe(450_000);
    expect(parseTokenAmount("1.000001", "USDT")).toBe(1_000_001);
    expect(() => parseTokenAmount("1.0000001", "USDC")).toThrow();
  });

  it("accepts a wallet address and rejects anything else", () => {
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isSolanaAddress(" 11111111111111111111111111111111 ")).toBe(true);
    expect(isSolanaAddress("")).toBe(false);
    expect(isSolanaAddress("not-a-wallet")).toBe(false);
  });
});
