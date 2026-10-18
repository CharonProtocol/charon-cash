import { describe, expect, it } from "vitest";
import {
  describePaymentError,
  formatTokenAmount,
  isSoftPaymentError,
  isSolanaAddress,
  parseTokenAmount,
} from "./payment";

describe("selected payment asset", () => {
  it("converts SOL and stablecoins using their own decimal precision", () => {
    expect(parseTokenAmount("0.45", "SOL")).toBe(450_000_000);
    expect(parseTokenAmount("0.45", "USDC")).toBe(450_000);
    expect(parseTokenAmount("1.000001", "USDT")).toBe(1_000_001);
    expect(() => parseTokenAmount("1.0000001", "USDC")).toThrow();
  });

  it("formats a selected asset and hides nothing about a zero balance", () => {
    expect(formatTokenAmount("4800000000", "SOL")).toBe("4.80");
    expect(formatTokenAmount("120000000", "USDC")).toBe("120.00");
    expect(formatTokenAmount("0", "USDT")).toBe("0.00");
  });

  it("keeps an unregistered recipient on the form and a declined signature as a failure", () => {
    expect(
      describePaymentError("User is not registered on the network"),
    ).toBe("That recipient is not registered on Charon.");
    expect(isSoftPaymentError("User is not registered on the network")).toBe(
      true,
    );
    expect(describePaymentError("User rejected the request.")).toBe(
      "The signature was declined.",
    );
    expect(isSoftPaymentError("User rejected the request.")).toBe(false);
  });

  it("accepts a wallet address and rejects anything else", () => {
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    expect(isSolanaAddress(" 11111111111111111111111111111111 ")).toBe(true);
    expect(isSolanaAddress("")).toBe(false);
    expect(isSolanaAddress("not-a-wallet")).toBe(false);
  });
});
