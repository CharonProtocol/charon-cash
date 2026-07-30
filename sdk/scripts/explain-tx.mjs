import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Connection,
} from "@solana/web3.js"

const PROGRAM = new PublicKey("D1wKrzkBsmBLEUp1cjDRMt3Gm9QwMWoavZLsZaE8AHMQ")
const payer = Keypair.generate()

const [treeAccount, treeBump] = PublicKey.findProgramAddressSync([Buffer.from("merkle_tree")], PROGRAM)
const [treeToken, treeTokenBump] = PublicKey.findProgramAddressSync([Buffer.from("tree_token")], PROGRAM)
const [globalConfig, globalBump] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PROGRAM)

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

let blockhash = "11111111111111111111111111111111"
try {
  blockhash = (await new Connection("http://localhost:8899").getLatestBlockhash()).blockhash
  console.log("(fetched real blockhash from surfpool)")
} catch {
  console.log("(surfpool unreachable — using dummy blockhash; structure is identical)")
}

const msg = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash: blockhash,
  instructions: [ix],
}).compileToV0Message()
const tx = new VersionedTransaction(msg)
tx.sign([payer])
const bytes = tx.serialize()
const hex = Buffer.from(bytes).toString("hex")

console.log("\n===== 1) WHAT THE WALLET PRODUCES AFTER SIGNING =====")
console.log("type        : VersionedTransaction (v0)")
console.log("signatures  :", tx.signatures.length, "x 64-byte ed25519 signature(s)")
console.log("  sig[0]    :", Buffer.from(tx.signatures[0]).toString("hex").slice(0, 64), "...")
console.log("message.header           :", JSON.stringify(tx.message.header))
console.log("message.staticAccountKeys :")
tx.message.staticAccountKeys.forEach((k, i) => console.log("     [" + i + "]", k.toBase58()))
console.log("message.compiledInstructions :")
for (const ci of tx.message.compiledInstructions) {
  console.log("   program  =", tx.message.staticAccountKeys[ci.programIdIndex].toBase58())
  console.log("   accounts =", Array.from(ci.accountKeyIndexes))
  console.log("   data     =", Array.from(ci.data))
}

console.log("\n===== 2) SERIALIZED TO RAW BYTES : tx.serialize() =====")
console.log("total length :", bytes.length, "bytes")
console.log("wire layout  : [ sigCount(1B) | signatures(64B each) | message(rest) ]")
console.log("byte[0]      :", bytes[0], "<- signature count (1 signer)")
console.log("bytes[1..64] : first ed25519 signature (verifies payer signed the message)")
console.log("bytes[65..]  : the message (header + accounts + instruction + blockhash)")
console.log("hex (first 96 chars):", hex.slice(0, 96), "...")

console.log("\n===== 3) THE HTTP BODY WE POST to POST /api/relayer/submit =====")
console.log("Content-Type: application/json")
console.log("Body shape   : { \"transaction\": \"<whole hex string>\" }")
console.log("Body (real)  :")
console.log(JSON.stringify({ transaction: hex }, null, 0))
console.log("\n(above hex is " + hex.length + " chars = " + bytes.length + " bytes of the ENTIRE signed tx)")
