// v2 SHIELDED SPL end-to-end run against the local simnet + local workers.
// Companion to e2e-v2.mjs (the SOL path): this one exercises the SPL-only
// machinery -- the relayer's fee-ATA pre-instruction, a wallet pubkey in the
// recipient_token_account slot at ext=0, and the v0 + ALT submission.
//
// NET is deliberately small (1 token at 6 decimals -> bps fee 2_500 raw), below
// the 10_000-lamports SOL transfer floor: the fee must stay bps-exact because
// the floor never applies to token raw units.
//
// Prerequisites (see payroll/README.md "v2 local end-to-end"):
//   - surfpool with the program deployed, `wrangler dev` with the mint listed
//     in SUPPORTED_MINTS, the SPL tree initialized, and a funded treasurer
//     keypair holding tokens of that mint in its ATA.
//
// Usage: bun payroll/scripts/e2e-spl-v2.mjs   (bun resolves the SDK dist)
// Env: BACKEND_URL       (default http://127.0.0.1:8787)
//      RPC_URL           (default http://127.0.0.1:8899)
//      PROGRAM_ID        (default: current local deploy)
//      MINT              (required: supported mint with an initialized tree)
//      TREASURER_KEYPAIR (required: keypair whose ATA holds the mint's tokens)
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import nacl from "tweetnacl"

import {
  PrivacyCashClient,
  publishRecipientKeys,
  setCircuitBuffers,
  setBackendUrl,
  totalBalance,
} from "privacy-cash-sdk"

const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899"
const PROGRAM_ID = process.env.PROGRAM_ID ?? "3sGfrTUaetMjFEe1Qhwab8x1PFCpkDZ3tkmFwqkVwcWP"
const MINT_STR = process.env.MINT ?? ""
const TREASURER_KEYPAIR = process.env.TREASURER_KEYPAIR ?? ""

const DEPOSIT_RAW = 10_000_000 // 10 tokens at 6 decimals (fund the treasurer with at least this)
const NET_RAW = 1_000_000 // 1 token -> bps fee 2_500 raw, below the SOL floor

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

async function waitLeaves(treeKey, above, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const st = await getJson(`${BACKEND_URL}/api/merkle/${encodeURIComponent(treeKey)}`).catch(() => null)
    if (st?.ok && st.data.next_leaf_index > above) return st.data.next_leaf_index
    await sleep(2_000)
  }
  return -1
}

async function main() {
  if (!MINT_STR) throw new Error("MINT env is required (a supported mint with an initialized tree)")
  if (!TREASURER_KEYPAIR || !existsSync(TREASURER_KEYPAIR)) {
    throw new Error("TREASURER_KEYPAIR env is required (keypair whose ATA holds the mint's tokens)")
  }
  const MINT = new PublicKey(MINT_STR)
  console.log(`SPL e2e -- backend ${BACKEND_URL} rpc ${RPC_URL} program ${PROGRAM_ID} mint ${MINT.toBase58()}`)
  const conn = new Connection(RPC_URL, "confirmed")
  setBackendUrl(BACKEND_URL)

  step("environment")
  const info = await getJson(`${BACKEND_URL}/api/relayer/info`).catch(() => null)
  ok(!!info?.data?.program_id, "backend reachable")
  ok(info?.data?.program_id === PROGRAM_ID, "program id matches", `${info?.data?.program_id}`)
  const feeBps = info?.data?.withdrawal_fee_rate_bps ?? 25
  const EXPECTED_FEE = Math.ceil((NET_RAW * feeBps) / 10000)
  const mintRow = (info?.data?.supported_mints ?? []).find((m) => m.mint === MINT.toBase58())
  ok(!!mintRow, "mint listed as supported")
  const feeAta = new PublicKey(mintRow.fee_ata)
  const tree = await getJson(`${BACKEND_URL}/api/merkle/${MINT.toBase58()}`)
  ok(tree.ok, "SPL tree initialized", `next_leaf_index ${tree.data?.next_leaf_index}`)

  step("circuit buffers")
  const dir = circuitDir()
  setCircuitBuffers(
    new Uint8Array(readFileSync(path.join(dir, "transaction2.wasm"))),
    new Uint8Array(readFileSync(path.join(dir, "transaction2.zkey"))),
  )
  ok(true, "loaded", dir)

  const recipientKp = Keypair.generate()
  const recipient = localSigner(recipientKp)
  const treasurerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(TREASURER_KEYPAIR, "utf8"))),
  )
  const treasurer = localSigner(treasurerKp)

  step("recipient enrolls for private receiving")
  const keys = await publishRecipientKeys(recipient)
  ok(/^\d+$/.test(keys.notePubkey) && BigInt(keys.notePubkey) > 0n, "publish returned keys", keys.notePubkey.slice(0, 14) + "...")

  step("treasurer is funded (SOL for fees, tokens for the deposit)")
  let bal = await conn.getBalance(treasurer.publicKey)
  if (bal < LAMPORTS_PER_SOL) {
    const sig = await conn.requestAirdrop(treasurer.publicKey, 2 * LAMPORTS_PER_SOL)
    await conn.confirmTransaction(sig, "confirmed")
    bal = await conn.getBalance(treasurer.publicKey)
  }
  ok(bal >= LAMPORTS_PER_SOL, "treasurer SOL", `${bal} lamports`)
  const tAta = getAssociatedTokenAddressSync(MINT, treasurer.publicKey)
  const tok = await conn
    .getTokenAccountBalance(tAta)
    .then((r) => r.value.amount)
    .catch(() => "0")
  ok(Number(tok) >= DEPOSIT_RAW, "treasurer tokens", `${tok} raw`)

  step("treasurer deposits SPL into the private pool")
  const tClient = new PrivacyCashClient(treasurer, new PublicKey(PROGRAM_ID))
  const dep = await tClient.depositSPL(MINT, DEPOSIT_RAW)
  ok(typeof dep.signature === "string", "deposit relayed", dep.signature)
  ok(dep.leafIndex >= 0, "deposit leaf", `leaf ${dep.leafIndex}`)
  const leaves = await waitLeaves(MINT.toBase58(), dep.leafIndex)
  ok(leaves > dep.leafIndex, "deposit indexed", `next_leaf_index ${leaves}`)

  step("treasurer transfers a shielded SPL note (ext=0)")
  const feeBefore = Number(
    (await conn.getTokenAccountBalance(feeAta).catch(() => ({ value: { amount: "0" } }))).value.amount,
  )
  const tr = await tClient.transferNoteSPL(MINT, recipient.publicKey, NET_RAW)
  ok(typeof tr.signature === "string", "transfer relayed", tr.signature)
  ok(tr.recipientLamports === NET_RAW, "net recorded exactly", `${tr.recipientLamports}`)
  ok(
    tr.feeLamports === EXPECTED_FEE,
    "fee is bps-exact, NOT the lamports floor",
    `${tr.feeLamports}`,
  )

  step("recipient discovers and owns the SPL note")
  const rClient = new PrivacyCashClient(recipient, new PublicKey(PROGRAM_ID))
  await rClient.unlock()
  await rClient.refreshNotes()
  const notes = rClient.getNotes().filter((n) => !n.spent && n.mintAddress === MINT.toBase58())
  const received = notes.filter((n) => BigInt(n.amount) === BigInt(NET_RAW))
  ok(received.length === 1, "exactly one new note of the expected amount", `${received.length} found`)
  const splBal = totalBalance(recipient.publicKey, MINT.toBase58())
  ok(BigInt(splBal) >= BigInt(NET_RAW), "recipient SPL balance reflects the note", `${splBal}`)

  step("relayer fee arrived at the fee ATA in tokens")
  await sleep(3_000)
  const feeBal = await conn.getTokenAccountBalance(feeAta).catch(() => null)
  const feeAmt = feeBal ? feeBal.value.amount : "0"
  ok(
    Number(feeAmt) === feeBefore + EXPECTED_FEE,
    "fee ATA gained exactly the token fee",
    `+${Number(feeAmt) - feeBefore} raw (was ${feeBefore})`,
  )

  console.log(`\n${failures === 0 ? "ALL STEPS PASSED" : `${failures} STEP(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`\nFATAL: ${e?.stack ?? e}`)
  process.exit(1)
})
