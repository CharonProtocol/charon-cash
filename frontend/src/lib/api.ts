import { bytesToHex } from "@/lib/format"
import { BACKEND_URL } from "./config"
import type {
  HealthStatus,
  IndexerStatus,
  MerklePath,
  NullifierStatus,
  RelayerInfo,
  TreeState,
  UtxoCheckResponse,
  UtxoRangeResponse,
} from "@/lib/types"

const BASE = BACKEND_URL

export class BackendError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "BackendError"
    this.status = status
    this.code = code
  }
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new BackendError(0, "NETWORK", `cannot reach backend: ${(e as Error).message}`)
  }

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)
      ?.error
    throw new BackendError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `HTTP ${res.status}`,
    )
  }
  return data as T
}

type RawMerklePath = {
  path_elements: unknown
  path_indices: number[]
}

function normalizePath(data: RawMerklePath): MerklePath {
  const raw = data.path_elements
  const isNested =
    Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])
  const path_elements = isNested
    ? (raw as ArrayLike<number>[]).map((b) => bytesToHex(b))
    : (raw as string[])
  return {
    path_elements,
    path_indices: data.path_indices,
  }
}

export const api = {
  health: () => req<HealthStatus>("GET", "/health"),
  indexerStatus: () => req<IndexerStatus>("GET", "/indexer/status"),
  relayerInfo: () => req<RelayerInfo>("GET", "/api/relayer/info"),
  merkleState: (treeKey: string) =>
    req<TreeState>("GET", `/api/merkle/${encodeURIComponent(treeKey)}`),
  merkleProof: async (treeKey: string, leafIndex: number) =>
    normalizePath(
      await req<RawMerklePath>(
        "GET",
        `/api/merkle/${encodeURIComponent(treeKey)}/proof/${leafIndex}`,
      ),
    ),
  nullifier: (hash: string) =>
    req<NullifierStatus>("GET", `/api/nullifier/${encodeURIComponent(hash)}`),
  utxoRange: (treeKey: string, start: number, end: number) => {
    const q = new URLSearchParams({
      tree_key: treeKey,
      start: String(start),
      end: String(end),
    })
    return req<UtxoRangeResponse>("GET", `/api/utxos/range?${q}`)
  },
  utxoCheck: (encryptedHex: string, treeKey?: string) => {
    const hex = encryptedHex.replace(/^0x/i, "").toLowerCase()
    const q = treeKey ? `?tree_key=${encodeURIComponent(treeKey)}` : ""
    return req<UtxoCheckResponse>(
      "GET",
      `/api/utxos/check/${encodeURIComponent(hex)}${q}`,
    )
  },
}
