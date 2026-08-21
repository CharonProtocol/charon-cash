// v2 shielded-payroll end-to-end run against the local simnet + local workers.
//
// Prerequisites (see payroll/README.md "v2 local end-to-end"):
//   - surfpool (or any solana validator) at RPC_URL with the program deployed
//   - `wrangler dev` for workers/ with D1 migrations applied and .dev.vars set
//
// Usage: bun payroll/scripts/e2e-v2.mjs   (bun resolves the SDK's bundler-style
//        ESM dist; plain node cannot)
// Env: BACKEND_URL (default http://127.0.0.1:8787)
//      RPC_URL     (default http://127.0.0.1:8899)
//      PROGRAM_ID  (default local-only deploy 3sGfrTUaetMjFEe1Qhwab8x1PFCpkDZ3tkmFwqkVwcWP)
//      ADMIN_PASSWORD (default local-e2e; used only for the one-time tree initialize)
//      FUNDER_KEYPAIR (default ~/.config/solana/id.json; funds the throwaway wallets
//                      when the validator has no airdrop)
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js"
import nacl from "tweetnacl"

import {
  PrivacyCashClient,
  publishRecipientKeys,
  fetchRecipientKeys,
  setCircuitBuffers,
  setBackendUrl,
  totalBalance,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899"
const PROGRAM_ID = process.env.PROGRAM_ID ?? "3sGfrTUaetMjFEe1Qhwab8x1PFCpkDZ3tkmFwqkVwcWP"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-e2e"

// Amounts (lamports): deposit 1 SOL, transfer a 0.5 SOL note, withdraw 0.495 SOL
// (withdraw amount + relayer fee must fit inside the received note).
const DEPOSIT_LAMPORTS = 1_000_000_000
const TRANSFER_NET = 500_000_000
const WITHDRAW_NET = 495_000_000

const here = path.dirname(fileURLToPath(import.meta.url))
function circuitDir() {
  const candidates = [
    path.join(here, "..", "..", "privacy-cash-sdk", "circuit2"),
    path.join(here, "..", "..", "frontend", "public", "circuit"),
  ]
  for (const c of candidates) {
    if (existsSync(path.join(c, "transaction2.wasm"))) return c
  }
  throw new Error("circuit buffers not found (expected privacy-cash-sdk/circuit2)")
}

let failures = 0
function ok(cond, label, detail = "") {
  const mark = cond ? "PASS" : "FAIL"
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${detail ? ` -- ${detail}` : ""}`)
  if (!cond && process.exitCode === 0) process.exitCode = 1
}

function step(name) {
  console.log(`\n== ${name}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(url) {
  const res = await fetch(url)
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, ok: res.ok, data }
}

/**
 * A local signer: real ed25519 keypair, signs messages and txs. Duck-types the
 * tx class because the SDK resolves its own @solana/web3.js copy, so instanceof
 * checks against the script's copy never match.
 */
function localSigner(kp) {
  return {
    publicKey: kp.publicKey,
    signMessage: async (message) => nacl.sign.detached(message, kp.secretKey),
    signTransaction: async (tx) => {
      if (typeof tx.partialSign === "function") tx.partialSign(kp)
      else tx.sign([kp])
      return tx
    },
  }
}

async function fundIfEmpty(conn, dest, lamports, label) {
  const current = await conn.getBalance(dest)
  if (current >= lamports) {
    console.log(`  ..  ${label} already funded (${current} lamports)`)
    return
  }
  try {
    const sig = await conn.requestAirdrop(dest, lamports)
    await conn.confirmTransaction(sig, "confirmed")
    console.log(`  ..  ${label} funded via airdrop`)
    return
  } catch {
    /* validator without airdrop -- fall back to the CLI funder keypair */
  }
  const funderPath = process.env.FUNDER_KEYPAIR ?? path.join(homedir(), ".config", "solana", "id.json")
  if (!existsSync(funderPath)) throw new Error(`cannot fund ${label}: no airdrop and ${funderPath} missing`)
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(funderPath, "utf8"))))
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: dest, lamports }),
  )
  await sendAndConfirmTransaction(conn, tx, [funder])
  console.log(`  ..  ${label} funded from ${funderPath}`)
}

async function waitBalance(conn, dest, expected, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bal = await conn.getBalance(dest)
    if (bal === expected) return bal
    await sleep(1_000)
  }
  return await conn.getBalance(dest)
}

async function main() {
  console.log(`v2 e2e -- backend ${BACKEND_URL} rpc ${RPC_URL} program ${PROGRAM_ID}`)
  const conn = new Connection(RPC_URL, "confirmed")
  setBackendUrl(BACKEND_URL)

  step("environment")
  const rpcSlot = await conn.getSlot().catch(() => null)
  ok(rpcSlot !== null, "RPC reachable", `slot ${rpcSlot}`)
  const info = await getJson(`${BACKEND_URL}/api/relayer/info`).catch(() => null)
  ok(!!info?.data?.program_id, "backend relayer info reachable")
  const feeRecipient = info?.data?.fee_recipient
  ok(typeof feeRecipient === "string", "fee recipient reported", String(feeRecipient))
  ok(info?.data?.program_id === PROGRAM_ID, "backend PROGRAM_ID matches", `${info?.data?.program_id}`)

  step("one-time SOL tree initialize (admin)")
  // The relayer pays for initialize, so fund it first.
  await fundIfEmpty(conn, new PublicKey(feeRecipient), 5 * LAMPORTS_PER_SOL, "relayer")
  const initRes = await fetch(`${BACKEND_URL}/api/relayer/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": ADMIN_PASSWORD },
  }).catch(() => null)
  const initText = initRes ? await initRes.text().catch(() => "") : "unreachable"
  ok(
    initRes !== null && (initRes.ok || /already/i.test(initText)),
    "SOL tree initialized (or already was)",
    initRes?.ok ? initText.slice(0, 100) : initText.slice(0, 120),
  )

  step("circuit buffers")
  const dir = circuitDir()
  setCircuitBuffers(
    new Uint8Array(readFileSync(path.join(dir, "transaction2.wasm"))),
    new Uint8Array(readFileSync(path.join(dir, "transaction2.zkey"))),
  )
  ok(true, "loaded", dir)

  const recipientKp = Keypair.generate()
  const treasurerKp = Keypair.generate()
  writeFileSync("/tmp/payroll-v2-e2e-recipient.json", JSON.stringify(Array.from(recipientKp.secretKey)))
  writeFileSync("/tmp/payroll-v2-e2e-treasurer.json", JSON.stringify(Array.from(treasurerKp.secretKey)))
  const recipient = localSigner(recipientKp)
  const treasurer = localSigner(treasurerKp)

  step("recipient enrolls for private receiving")
  const keys = await publishRecipientKeys(recipient)
  ok(/^\d+$/.test(keys.notePubkey) && BigInt(keys.notePubkey) > 0n, "publish returned keys", keys.notePubkey.slice(0, 16) + "...")
  const row = await getJson(`${BACKEND_URL}/api/recipients/${recipient.publicKey.toBase58()}`)
  ok(row.ok && row.data?.note_pubkey === keys.notePubkey && row.data?.enc_pubkey === keys.encPubkey, "GET /api/recipients returns the row")
  const other = await fetchRecipientKeys(recipient.publicKey)
  ok(other !== null && other.notePubkey === keys.notePubkey, "SDK fetchRecipientKeys agrees")

  step("treasurer deposits to the private pool")
  await fundIfEmpty(conn, treasurer.publicKey, 3 * LAMPORTS_PER_SOL, "treasurer")
  const tClient = new PrivacyCashClient(treasurer, new PublicKey(PROGRAM_ID))
  const dep = await tClient.depositSOL(DEPOSIT_LAMPORTS)
  ok(typeof dep.signature === "string", "deposit relayed", dep.signature)
  ok(dep.leafIndex >= 0, "deposit leaf indexed", `leaf ${dep.leafIndex}`)

  step("treasurer transfers a shielded note (ext=0)")
  const transfer = await tClient.transferNoteSOL(recipient.publicKey, TRANSFER_NET)
  ok(typeof transfer.signature === "string", "transfer relayed", transfer.signature)
  ok(transfer.recipientLamports === TRANSFER_NET, "net recorded exactly", `${transfer.recipientLamports}`)
  ok(transfer.feeLamports > 0, "fee charged from sender notes", `${transfer.feeLamports}`)
  ok(typeof transfer.commitment === "string" && transfer.commitment.length === 64, "commitment returned", transfer.commitment.slice(0, 16) + "...")

  step("recipient discovers and owns the note")
  const rClient = new PrivacyCashClient(recipient, new PublicKey(PROGRAM_ID))
  await rClient.unlock()
  await rClient.refreshNotes()
  const notes = rClient.getNotes().filter((n) => !n.spent && n.mintAddress === WRAPPED_SOL_MINT)
  const received = notes.filter((n) => BigInt(n.amount) === BigInt(TRANSFER_NET))
  ok(received.length === 1, "exactly one new note of the expected amount", `${received.length} found`)
  const bal = totalBalance(recipient.publicKey, WRAPPED_SOL_MINT)
  ok(BigInt(bal) >= BigInt(TRANSFER_NET), "recipient balance reflects the note", `${bal}`)

  step("recipient withdraws the note to a fresh address")
  const feeBps = info?.data?.withdrawal_fee_rate_bps ?? 25
  const expectedNet = WITHDRAW_NET - Math.ceil((WITHDRAW_NET * feeBps) / 10000)
  const dest = Keypair.generate().publicKey
  const wd = await rClient.withdrawSOL(WITHDRAW_NET, dest)
  ok(typeof wd.signature === "string", "withdraw relayed", wd.signature)
  const destBal = await waitBalance(conn, dest, expectedNet)
  ok(destBal === expectedNet, "destination received gross minus the exact relayer fee", `${destBal} lamports (expected ${expectedNet})`)

  step("SPL variant")
  const mints = info?.data?.supported_mints ?? []

  let splChecked = false
  for (const m of mints) {
    const st = await getJson(`${BACKEND_URL}/api/merkle/${m.mint}`).catch(() => null)
    if (st?.ok) {
      splChecked = true
      console.log(`  [NOTE] supported mint with an initialized tree found (${m.mint}); run scripts/e2e-spl-v2.mjs for the SPL-specific path (fee-ATA pre-instruction, v0+ALT relay)`)
      break
    }
  }
  if (!splChecked) {
    console.log("  [SKIP] no SPL mint with an initialized tree on this backend (blank simnet); SPL variant skipped, not failed")
  }

  console.log(`\n${failures === 0 ? "ALL STEPS PASSED" : `${failures} STEP(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`\nFATAL: ${e?.stack ?? e}`)
  process.exit(1)
})
