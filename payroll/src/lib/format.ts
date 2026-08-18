export function shortHash(s: string, head = 8, tail = 6): string {
  if (!s) return s
  if (s.length <= head + tail + 1) return s
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

export function lamportsToSol(lamports: number | string): number {
  return Number(lamports) / 1_000_000_000
}

export function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000)
}

export function isValidBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim())
}

/** Exact bigint formatting of a raw amount: no float math. */
export function rawToHuman(raw: bigint, decimals: number): string {
  const neg = raw < 0n
  const abs = neg ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "")
  const s = frac ? `${whole}.${frac}` : `${whole}`
  return neg ? `-${s}` : s
}
