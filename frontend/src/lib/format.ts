export function bytesToHex(bytes: ArrayLike<number> | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = "0x"
  for (let i = 0; i < arr.length; i++) {
    out += arr[i].toString(16).padStart(2, "0")
  }
  return out
}

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

export function isValidHex32(s: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim())
}

export function isValidBase58(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim())
}

export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`
}
