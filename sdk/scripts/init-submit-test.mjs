import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js"
import fs from "node:fs"

const PROGRAM = new PublicKey("D1wKrzkBsmBLEUp1cjDRMt3Gm9QwMWoavZLsZaE8AHMQ")
const RPC = "http://localhost:8899"
const BACKEND = "http://localhost:8080"
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync("/Users/singupallikartik/.config/solana/id.json", "utf8"))),
)

const [treeAccount, treeBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("merkle_tree")], PROGRAM)
const [treeToken, treeTokenBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("tree_token")], PROGRAM)
const [globalConfig, globalBump] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_config")], PROGRAM)

const ix = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: treeAccount, isSigner: false, isWritable: true },
    { pubkey: treeToken, isSigner: false, isWritable: true },
    { pubkey: globalConfig, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([0, treeBump, treeTokenBump, globalBump]),
})

const conn = new Connection(RPC, "confirmed")
const { blockhash } = await conn.getLatestBlockhash()
const msg = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: blockhash,
  instructions: [ix],
}).compileToV0Message()
const tx = new VersionedTransaction(msg)
tx.sign([payer])
const hex = Buffer.from(tx.serialize()).toString("hex")

console.log("payer:", payer.publicKey.toBase58())
console.log("posting signed Initialize tx to", BACKEND + "/api/relayer/submit")
const res = await fetch(BACKEND + "/api/relayer/submit", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ transaction: hex }),
})
console.log("HTTP", res.status)
console.log("body:", await res.text())
