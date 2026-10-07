import type { Token } from "../components/dashboard/TokenIcon";
export const TOKEN_DECIMALS: Record<Token, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
};
export const SOL_POOL_MINT = "11111111111111111111111111111112";
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
