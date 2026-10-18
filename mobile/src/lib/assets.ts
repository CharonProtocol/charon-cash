// Assets the app moves: SOL plus every token pool the backend lists.

export interface Asset {
  /** "SOL" or the token mint. */
  key: string;
  symbol: string;
  decimals: number;
}

export const SOL: Asset = { key: "SOL", symbol: "SOL", decimals: 9 };

export function assetsFrom(mints: { mint: string; symbol: string | null; decimals: number | null }[]): Asset[] {
  const tokens = mints
    .filter((m) => m.decimals != null)
    .map((m) => ({ key: m.mint, symbol: m.symbol ?? m.mint.slice(0, 4), decimals: m.decimals as number }));
  return [SOL, ...tokens];
}

/** "1.5" at 9 decimals -> "1500000000"; null when it is not a positive amount. */
export function parseUnits(text: string, decimals: number): string | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > decimals) return null;
  const raw = BigInt((whole || "0") + frac.padEnd(decimals, "0"));
  return raw > 0n ? raw.toString() : null;
}

/** "1500000000" at 9 decimals -> "1.5" (at most `maxFrac` fraction digits). */
export function formatUnits(raw: string | bigint, decimals: number, maxFrac = 4): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
