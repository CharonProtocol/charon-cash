// On-chain check of one run: every employee in the CSV got exactly one note in
// leaves [from, to), for the CSV amount to the lamport, that they can spend
// (commitment rebuilt with their own keys matches the leaf), in SOL, unspent.
// Decrypts with the local test employees' keys (make-employees.ts).
//
//   bun bench-kit/verify-notes.ts <keys.json> <employees.csv> <from> <to> [backend]
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

import * as sdk from "../sdk/src/index"

const req = createRequire(path.join(import.meta.dir, "../sdk/package.json"))
const { Keypair } = req("@solana/web3.js")
const nacl = req("tweetnacl")
const { WasmFactory } = req("@lightprotocol/hasher.rs")

const [keysFile, csvFile, fromArg, toArg, backend = "http://localhost:8080"] = process.argv.slice(2)
if (!keysFile || !csvFile || !fromArg || !toArg) {
  throw new Error("usage: bun bench-kit/verify-notes.ts <keys.json> <employees.csv> <from> <to> [backend]")
}
const wasm = await WasmFactory.getInstance()
const toLamports = (s: string) => {
  const [w, f = ""] = s.split(".")
  return BigInt(w + f.padEnd(9, "0").slice(0, 9))
}
const want = new Map(
  readFileSync(csvFile, "utf8").trim().split("\n").slice(1).map((l) => {
    const [address, amount] = l.split(",")
    return [address, toLamports(amount)] as const
  }),
)
const sign = (m: string, sk: Uint8Array) => nacl.sign.detached(new TextEncoder().encode(m), sk)
const employees = (JSON.parse(readFileSync(keysFile, "utf8")) as Array<{ secretKey: string }>).map((k) => {
  const kp = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(k.secretKey, "base64")))
  const enc = new sdk.EncryptionService()
  enc.deriveFromSignature(sign(sdk.SIGN_MESSAGE, kp.secretKey), sign(sdk.RECEIVE_SIGN_MESSAGE, kp.secretKey))
  return { wallet: kp.publicKey.toBase58() as string, enc }
})

type Found = { amount: bigint; leaf: number; sig: string; commitOk: boolean; sol: boolean; spent: boolean }
const found = new Map<string, Found[]>()
// An empty range means the run's leaves went to a different server than this
// one (two backends on :8080) or the backend restarted: say so, don't just
// report "0 notes" per employee.
const problems: string[] = []
const from = Number(fromArg)
const to = Number(toArg)
let utxos: Array<{ leaf_index: number; commitment: string; encrypted_output_hex: string; signature: string }> = []
if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
  problems.push(`${backend} reported no new leaves for this run (before ${fromArg}, after ${toArg}): another server may answer there`)
} else {
  const page = await (await fetch(`${backend}/api/utxos/range?tree_key=sol&start=${from}&end=${to}`)).json().catch(() => null)
  if (Array.isArray(page?.utxos)) utxos = page.utxos
  if (utxos.length === 0) problems.push(`${backend} returned no notes for leaves ${from}..${to}: another server may answer there`)
}
for (const u of utxos) {
  const bytes = Buffer.from(u.encrypted_output_hex, "hex")
  for (const e of employees) {
    let note
    try {
      note = await e.enc.decryptUtxo(bytes, wasm)
    } catch {
      continue
    }
    if (note.amount.isZero()) continue
    note.index = u.leaf_index
    const commitment = sdk.fieldToHex32(note.getCommitment()).replace(/^0x/, "").toLowerCase()
    const nullifier = sdk.fieldToHex32(await note.getNullifier())
    const spent = (await (await fetch(`${backend}/api/nullifier/${nullifier}`)).json()).spent === true
    const list = found.get(e.wallet) ?? []
    list.push({
      amount: BigInt(note.amount.toString()),
      leaf: u.leaf_index,
      sig: u.signature,
      commitOk: commitment === u.commitment.replace(/^0x/, "").toLowerCase(),
      sol: note.mintAddress === sdk.WRAPPED_SOL_MINT,
      spent,
    })
    found.set(e.wallet, list)
  }
}

let paid = 0n
let failedEmployees = 0
for (const [address, amount] of want) {
  const notes = found.get(address) ?? []
  const n = notes[0]
  const why: string[] = []
  if (notes.length !== 1) why.push(`${notes.length} notes`)
  if (n && n.amount !== amount) why.push(`amount ${n.amount} != csv ${amount}`)
  if (n && !n.commitOk) why.push("commitment mismatch (not spendable)")
  if (n && !n.sol) why.push("wrong mint")
  if (n && n.spent) why.push("already spent")
  if (n) paid += n.amount
  if (why.length) {
    failedEmployees++
    problems.push(`${address}: ${why.join(", ")}`)
  }
}
const all = [...found.values()].flat()
const result = {
  employees: want.size,
  allChecksPassed: want.size - failedEmployees,
  paidLamports: paid.toString(),
  csvLamports: [...want.values()].reduce((s, v) => s + v, 0n).toString(),
  distinctTxs: new Set(all.map((n) => n.sig)).size,
  distinctLeaves: new Set(all.map((n) => n.leaf)).size,
  problems,
}
console.log(JSON.stringify(result))
process.exit(problems.length ? 1 : 0)
