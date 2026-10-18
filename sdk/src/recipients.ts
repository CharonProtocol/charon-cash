import { PublicKey } from "@solana/web3.js"
import { WasmFactory } from "@lightprotocol/hasher.rs"

import { getBackendUrl } from "./merkle"
import { RECEIVE_SIGN_MESSAGE, SIGN_MESSAGE } from "./constants"
import type { Signer } from "./client"
import { EncryptionService, Keypair } from "./crypto"

export const RECIPIENT_PUT_PREFIX = "privacy-cash-recipients-v1"

export interface RecipientKeys {
  /** Poseidon note-spending pubkey (decimal field-element string). */
  notePubkey: string
  /** x25519 encryption pubkey (64-char hex). */
  encPubkey: string
}

function b58(wallet: PublicKey | string): string {
  return wallet instanceof PublicKey ? wallet.toBase58() : wallet
}

/**
 * One-time enrollment for private receiving. The wallet signs three messages:
 * SIGN_MESSAGE (derives the existing note keypair, unchanged), RECEIVE_SIGN_MESSAGE
 * (derives the x25519 receive key), and the registry message binding wallet +
 * both pubkeys. The backend verifies the third signature before storing, so
 * nobody can overwrite someone else's keys.
 */
export async function publishRecipientKeys(
  signer: Signer,
  /** Keys an unlocked client already derived (client.receiveKeys()): skips
   * re-signing SIGN_MESSAGE and RECEIVE_SIGN_MESSAGE, one prompt instead of three. */
  derived?: RecipientKeys,
  /** The wallet's note-backup key (client.backupKey()): the same signature links
   * it, so enrolling costs one prompt instead of registry + backup link. */
  backupKey?: string,
): Promise<RecipientKeys> {
  let notePubkey: string
  let encPubkey: string
  if (derived) {
    ;({ notePubkey, encPubkey } = derived)
  } else {
    const sig = await signer.signMessage(new TextEncoder().encode(SIGN_MESSAGE))
    const receiveSig = await signer.signMessage(
      new TextEncoder().encode(RECEIVE_SIGN_MESSAGE),
    )
    const enc = new EncryptionService()
    enc.deriveFromSignature(sig, receiveSig)
    const wasm = await WasmFactory.getInstance()
    notePubkey = new Keypair(enc.utxoPrivateKey, wasm).pubkey.toString()
    encPubkey = Buffer.from(enc.getReceivePublicKey()!).toString("hex")
  }

  const wallet = signer.publicKey.toBase58()
  const message = `${RECIPIENT_PUT_PREFIX}\n${wallet}\n${notePubkey}\n${encPubkey}${backupKey ? `\n${backupKey}` : ""}`
  const registrySig = await signer.signMessage(new TextEncoder().encode(message))

  const res = await fetch(getBackendUrl() + "/api/recipients", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet,
      note_pubkey: notePubkey,
      enc_pubkey: encPubkey,
      signature: Buffer.from(registrySig).toString("base64"),
      ...(backupKey ? { backup_key: backupKey } : {}),
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    let data: unknown = null
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    const err = (data as { error?: { message?: string } } | null)?.error
    throw new Error(err?.message ?? `HTTP ${res.status}`)
  }
  cache.set(wallet, { notePubkey, encPubkey })
  return { notePubkey, encPubkey }
}

const cache = new Map<string, RecipientKeys>()

/** Registered receive keys for a wallet, or null when the wallet has not enrolled. */
export async function fetchRecipientKeys(
  wallet: PublicKey | string,
): Promise<RecipientKeys | null> {
  const key = b58(wallet)
  const hit = cache.get(key)
  if (hit) return hit
  const res = await fetch(
    getBackendUrl() + "/api/recipients/" + encodeURIComponent(key),
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const text = await res.text()
    let data: unknown = text
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    const err = (data as { error?: { message?: string } } | null)?.error
    throw new Error(err?.message ?? `HTTP ${res.status}`)
  }
  const row = (await res.json()) as {
    note_pubkey: string
    enc_pubkey: string
  }
  const keys = { notePubkey: row.note_pubkey, encPubkey: row.enc_pubkey }
  cache.set(key, keys)
  return keys
}

/**
 * Registered receive keys for many wallets in as few round trips as possible
 * (one POST per 90 wallets). Missing entries mean "not enrolled" — same
 * contract as fetchRecipientKeys returning null. Order of `wallets` is not
 * preserved in the result; use the returned Map. Falls back to per-wallet
 * fetches against backends without the batch endpoint.
 */
export async function fetchRecipientsBatch(
  wallets: Array<PublicKey | string>,
): Promise<Map<string, RecipientKeys | null>> {
  const keys = wallets.map(b58)
  const out = new Map<string, RecipientKeys | null>()
  const pending: string[] = []
  for (const key of keys) {
    const hit = cache.get(key)
    if (hit) out.set(key, hit)
    else {
      out.set(key, null)
      pending.push(key)
    }
  }
  if (pending.length === 0) return out
  try {
    const results: Array<{ wallet: string; note_pubkey: string; enc_pubkey: string }> = []
    for (let i = 0; i < pending.length; i += 90) {
      const res = await fetch(getBackendUrl() + "/api/recipients/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallets: pending.slice(i, i + 90) }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { results?: typeof results }
      if (!Array.isArray(data.results)) throw new Error("malformed recipients batch")
      results.push(...data.results)
    }
    for (const row of results) {
      const keys2 = { notePubkey: row.note_pubkey, encPubkey: row.enc_pubkey }
      cache.set(row.wallet, keys2)
      out.set(row.wallet, keys2)
    }
  } catch {
    // older backend: per-wallet lookups keep the same semantics
    await Promise.all(pending.map((key) => fetchRecipientKeys(key)))
    for (const key of pending) out.set(key, cache.get(key) ?? null)
  }
  return out
}
