import { PublicKey } from "@solana/web3.js"
import BN from "bn.js"

export const FIELD_SIZE = new BN(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
)

export const MERKLE_TREE_DEPTH = 26

export const SOL_MINT = new PublicKey("11111111111111111111111111111111")
export const WRAPPED_SOL_MINT = "11111111111111111111111111111112"

/** SIWS `Version` field. Stable — not a per-session nonce. */
export const SIWS_VERSION = "1"

/**
 * SIWS statement. Must not contain newlines (CAIP / Phantom SIWS).
 * This signature is keccak'd into the shielded spend key.
 */
export const SIWS_STATEMENT =
  "Derive my SilentPay pool keys from this signature. Only approve this on the site your wallet displays."

/** Fields for Sign In With Solana. Omit nonce / issuedAt so the spend key stays deterministic. */
export type SiwsUnlockInput = {
  domain: string
  address: string
  statement?: string
  uri?: string
  version?: string
  chainId?: string
}

export type SiwsSignInInput = {
  domain: string
  address: string
  statement?: string
  uri?: string
  version?: string
  chainId?: string
}

export type SiwsSignInOutput = {
  signature: Uint8Array
  signedMessage: Uint8Array
}

/** Host only (`app.example` or `127.0.0.1:5173`), never a full URL. */
export function normalizeSiwsDomain(domain: string): string {
  const d = domain.trim()
  if (!d) throw new Error("SIWS: domain required")
  if (/^https?:\/\//i.test(d)) {
    try {
      return new URL(d).host
    } catch {
      throw new Error("SIWS: invalid domain URL")
    }
  }
  return d.replace(/\/+$/, "")
}

/**
 * Canonical SIWS text (`createSignInMessageText` from the Solana Wallet Standard).
 * Phantom `signIn` constructs the same bytes and checks `domain` against the
 * requesting page — a phishing origin cannot reuse the production message.
 */
export function buildUnlockMessage(input: SiwsUnlockInput): string {
  const domain = normalizeSiwsDomain(input.domain)
  const address = input.address.trim()
  if (!address) throw new Error("SIWS: address required")
  const statement = (input.statement ?? SIWS_STATEMENT).trim()
  if (statement.includes("\n")) {
    throw new Error("SIWS: statement must not contain newlines")
  }
  let message = `${domain} wants you to sign in with your Solana account:\n${address}`
  if (statement) message += `\n\n${statement}`
  const fields: string[] = []
  const uri = input.uri?.trim()
  if (uri) fields.push(`URI: ${uri.replace(/\/+$/, "")}`)
  const version = (input.version ?? SIWS_VERSION).trim()
  if (version) fields.push(`Version: ${version}`)
  const chainId = input.chainId?.trim()
  if (chainId) fields.push(`Chain ID: ${chainId}`)
  if (fields.length) message += `\n\n${fields.join("\n")}`
  return message
}

export function requireStableSiws(signedMessage: Uint8Array, expected: string): void {
  const signed = new TextDecoder().decode(signedMessage)
  if (signed !== expected) {
    throw new Error(
      "SIWS mismatch: wallet signed a different message (nonce/issuedAt?). SilentPay needs a stable SIWS payload (no nonce) to derive your pool keys.",
    )
  }
}

export function defaultSiwsDomain(): string {
  if (typeof window !== "undefined" && window.location?.host) {
    return window.location.host
  }
  return "localhost"
}

export function defaultSiwsUri(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin.replace(/\/+$/, "")
  }
  return "http://localhost"
}

function clusterFromRpc(url: string): string {
  const u = url.toLowerCase()
  if (/devnet/.test(u)) return "devnet"
  if (/testnet/.test(u)) return "testnet"
  if (/mainnet/.test(u)) return "mainnet"
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(u)) return "localnet"
  return "localnet"
}

/**
 * Optional SIWS Chain ID (`mainnet` / `devnet` / `localnet`).
 * Do not pass this to Phantom `signIn` unless it matches the wallet's
 * selected network — custom localhost RPCs are usually `mainnet` in Phantom.
 */
export function inferSiwsChainId(rpcUrl?: string): string {
  const env = getEnv()
  if (rpcUrl) return clusterFromRpc(rpcUrl)
  const explicit = env.VITE_SOLANA_CLUSTER?.trim()
  if (explicit) {
    const c = explicit.toLowerCase()
    if (c === "mainnet-beta") return "mainnet"
    return c
  }
  return clusterFromRpc(env.VITE_SOLANA_RPC_URL ?? "")
}

export const DISC_TRANSACT = 2
export const DISC_TRANSACT_SPL = 3
export const DISC_SWAP = 7
export const DISC_WRAP_SOL = 8
export const SWAP_IX_DISCRIMINATOR = Buffer.from([DISC_SWAP])
export const WRAP_SOL_IX_DISCRIMINATOR = Buffer.from([DISC_WRAP_SOL])

export const JUPITER_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
)
export const NATIVE_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
)

export const SEED = {
  TREE_ACCOUNT: "merkle_tree",
  TREE_TOKEN: "tree_token",
  GLOBAL_CONFIG: "global_config",
  NULLIFIER0: "nullifier0",
  NULLIFIER1: "nullifier1",
} as const

export const SOL_TREE_KEY = "sol"

function getEnv(): Record<string, string | undefined> {
  try {
    return (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
  } catch {
    return {}
  }
}

export function backendUrl(): string {
  const env = getEnv()
  return (env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(
    /\/$/,
    "",
  )
}

/**
 * Origin serving `/api/relayer/*`.
 *
 * The relayer is a separate service from the indexer in production — it holds a hot
 * signing key and has its own rate limits and failure modes, so it should not share
 * a process with the thing serving public Merkle data. In dev both are the same shim,
 * so this falls back to the backend URL and needs no configuration.
 */
export function relayerUrl(): string {
  const env = getEnv()
  const url = env.VITE_RELAYER_URL
  return url ? url.replace(/\/$/, "") : backendUrl()
}

export function envProgramId(): PublicKey | null {
  const env = getEnv()
  const v = env.VITE_PROGRAM_ID
  try {
    return v ? new PublicKey(v) : null
  } catch {
    return null
  }
}
