#!/usr/bin/env bun
/**
 * Create (or extend) a local Address Lookup Table for SPL Transact txs.
 * Writes VITE_ALT_ADDRESS into frontend/.env.
 *
 * Usage:
 *   PROGRAM_ID=... FEE_RECIPIENT=... MINT=... bun scripts/create-alt.mjs
 */
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const RPC = process.env.VITE_SOLANA_RPC_URL || "http://localhost:8899"
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || process.env.VITE_PROGRAM_ID || "",
)
const FEE_RECIPIENT = process.env.FEE_RECIPIENT
  ? new PublicKey(process.env.FEE_RECIPIENT)
  : null
const MINT = process.env.MINT
  ? new PublicKey(process.env.MINT)
  : new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
)
const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
)

function loadKeypair() {
  const path =
    process.env.KEYPAIR || join(homedir(), ".config/solana/id.json")
  const raw = JSON.parse(readFileSync(path, "utf8"))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

function dedupe(keys) {
  const seen = new Set()
  return keys.filter((k) => {
    const s = k.toBase58()
    if (seen.has(s)) return false
    seen.add(s)
    return true
  })
}

async function send(connection, payer, ixs) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash()
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([payer])
  const sig = await connection.sendRawTransaction(tx.serialize())
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  )
  return sig
}

function upsertEnv(alt) {
  const envPath = join(ROOT, "frontend", ".env")
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  if (/^VITE_ALT_ADDRESS=/m.test(text)) {
    text = text.replace(/^VITE_ALT_ADDRESS=.*$/m, `VITE_ALT_ADDRESS=${alt}`)
  } else {
    text = text.trimEnd() + `\nVITE_ALT_ADDRESS=${alt}\n`
  }
  writeFileSync(envPath, text)
}

if (!process.env.PROGRAM_ID && !process.env.VITE_PROGRAM_ID) {
  console.error("PROGRAM_ID (or VITE_PROGRAM_ID) required")
  process.exit(1)
}

const connection = new Connection(RPC, "confirmed")
const payer = loadKeypair()
const [globalConfig] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_config")],
  PROGRAM_ID,
)
const [treeAccount] = PublicKey.findProgramAddressSync(
  [Buffer.from("merkle_tree"), MINT.toBytes()],
  PROGRAM_ID,
)
const treeAta = getAssociatedTokenAddressSync(MINT, globalConfig, true)

let feeRecipient = FEE_RECIPIENT
if (!feeRecipient) {
  // Try reading fee_recipient from global config account (layout-dependent);
  // fall back to payer if not initialized.
  feeRecipient = payer.publicKey
}
const feeAta = getAssociatedTokenAddressSync(MINT, feeRecipient, true)

const addresses = dedupe([
  PROGRAM_ID,
  globalConfig,
  treeAccount,
  treeAta,
  feeRecipient,
  feeAta,
  MINT,
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  ComputeBudgetProgram.programId,
])

const existing = process.env.VITE_ALT_ADDRESS
  ? new PublicKey(process.env.VITE_ALT_ADDRESS)
  : null

let altAddress = existing
if (altAddress) {
  const got = await connection.getAddressLookupTable(altAddress)
  if (!got.value) altAddress = null
}

if (!altAddress) {
  const slot = await connection.getSlot()
  const [createIx, created] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot - 1,
  })
  await send(connection, payer, [createIx])
  altAddress = created
  console.log("created ALT", altAddress.toBase58())
} else {
  console.log("using existing ALT", altAddress.toBase58())
}

const table = await connection.getAddressLookupTable(altAddress)
const have = new Set(
  (table.value?.state.addresses ?? []).map((a) => a.toBase58()),
)
const missing = addresses.filter((a) => !have.has(a.toBase58()))
if (missing.length) {
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20)
    const ix = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: altAddress,
      addresses: chunk,
    })
    await send(connection, payer, [ix])
  }
  console.log("extended ALT with", missing.length, "addresses")
  // one slot for activation
  await new Promise((r) => setTimeout(r, 800))
} else {
  console.log("ALT already has all addresses")
}

upsertEnv(altAddress.toBase58())
console.log("wrote VITE_ALT_ADDRESS to frontend/.env")
