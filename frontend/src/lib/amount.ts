export function parseSolAmount(value: string): number {
  if (!/^\d+(?:\.\d{1,9})?$/.test(value))
    throw new Error("Enter a SOL amount with up to 9 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const lamports =
    BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (lamports <= 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Enter a positive amount within the supported range.");
  return Number(lamports);
}
export function formatSol(lamports: string): string {
  const value = BigInt(lamports);
  return `${value / 1_000_000_000n}.${(value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "") || "00"}`;
}
