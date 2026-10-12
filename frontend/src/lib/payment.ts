import { PublicKey } from "@solana/web3.js";
import type { Token } from "../components/dashboard/TokenIcon";
export const TOKEN_DECIMALS: Record<Token, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
};
export const SOL_POOL_MINT = "11111111111111111111111111111112";
export function formatTokenAmount(raw: string, token: Token): string {
  const decimals = TOKEN_DECIMALS[token];
  const value = BigInt(raw || "0");
  const base = 10n ** BigInt(decimals);
  const trimmed = (value % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const fraction = (trimmed || "00").padEnd(2, "0");
  return `${value / base}.${fraction}`;
}
export function parseTokenAmount(value: string, token: Token): number {
  const decimals = TOKEN_DECIMALS[token];
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(value))
    throw new Error(
      `Enter a ${token} amount with up to ${decimals} decimal places.`,
    );
  const [whole, fraction = ""] = value.split(".");
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Enter a positive amount within the supported range.");
  return Number(units);
}
export function describePaymentError(message: string): string {
  if (/not registered/i.test(message))
    return "That recipient is not registered on Charon.";
  if (/reject|declin/i.test(message)) return "The signature was declined.";
  if (/no utxos/i.test(message))
    return "No private balance is available for that asset.";
  return message;
}

export function isSoftPaymentError(message: string): boolean {
  return /not registered|no utxos|only withdraw equal or less/i.test(message);
}

export function isSolanaAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}
