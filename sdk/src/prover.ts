import { utils } from "ffjavascript"
import { getBackendUrl } from "./merkle"

export interface HostedProof {
  proofA: number[]
  proofB: number[]
  proofC: number[]
  publicSignals: string[]
}

function hexToBytes(hex: string): number[] {
  const h = hex.replace(/^0x/i, "")
  if (h.length % 2 !== 0) throw new Error("odd hex length")
  const out = new Array<number>(h.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function jsonSafeCircuitInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const replaceBytes = (v: unknown): unknown => {
    if (v instanceof Uint8Array) {
      let hex = "0x"
      for (let i = 0; i < v.length; i++) hex += v[i]!.toString(16).padStart(2, "0")
      return hex
    }
    if (Array.isArray(v)) return v.map(replaceBytes)
    // BN.js instances have `.eq`; leave them for stringifyBigInts.
    if (v && typeof v === "object" && typeof (v as { eq?: unknown }).eq !== "function") {
      const o: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        o[k] = replaceBytes(val)
      }
      return o
    }
    return v
  }
  return utils.stringifyBigInts(replaceBytes(input)) as Record<string, unknown>
}

async function proveHosted(input: Record<string, unknown>): Promise<HostedProof> {
  const res = await fetch(getBackendUrl() + "/api/prove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(jsonSafeCircuitInput(input)),
  })
  const json = await res.json()
  const data = json.data ?? json
  if (!res.ok || json.success === false) {
    throw new Error(json.error?.message ?? json.message ?? `prove failed (${res.status})`)
  }
  const proofA = hexToBytes(String(data.proof_a))
  const proofB = hexToBytes(String(data.proof_b))
  const proofC = hexToBytes(String(data.proof_c))
  if (proofA.length !== 32 || proofB.length !== 64 || proofC.length !== 32) {
    throw new Error(
      `hosted prove returned unexpected sizes ${proofA.length}/${proofB.length}/${proofC.length}`,
    )
  }
  return {
    proofA,
    proofB,
    proofC,
    publicSignals: data.public_signals,
  }
}

/**
 * Generate a groth16 proof via POST /api/prove (ark-groth16).
 * Returns compressed 32/64/32 bytes. Does not log the witness.
 */
export async function prove(input: Record<string, unknown>): Promise<HostedProof> {
  return proveHosted(input)
}

/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export function parseToBytesArray(publicSignals: string[]): number[][] {
  return JSON.parse(JSON.stringify(publicSignals)).map((s: string) =>
    Array.from(
      utils.leInt2Buff(utils.unstringifyBigInts(s), 32),
    ).reverse(),
  )
}
