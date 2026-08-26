// Generates a fixed witness for transaction2 — same input shape as
// payroll/src/lib/native-prover.test.ts, so all provers run on identical data.
// Run with bun (SDK dist uses extensionless ESM internals node can't resolve).
import { writeFileSync } from "node:fs"

const CIRCUIT = "/Users/singupallikartik/Developer/chat/privacy-cash/programs/privacy-cash/artifacts/circuits"
const { wtns } = await import("snarkjs")
const { utils } = await import("ffjavascript")
const { WasmFactory } = await import("@lightprotocol/hasher.rs")
const { EncryptionService, Keypair, Utxo, getExtDataHash, WRAPPED_SOL_MINT } = await import("privacy-cash-sdk")

const hasher = await WasmFactory.getInstance()
const enc = new EncryptionService()
enc.deriveFromSignature(new Uint8Array(64).fill(9))
const kp = new Keypair(enc.utxoPrivateKey, hasher)

const dummyPath = new Array(26).fill("0")
const inputs = [new Utxo({ wasm: hasher, keypair: kp }), new Utxo({ wasm: hasher, keypair: kp })]
const depositAmount = 10_000_000
const outputs = [
  new Utxo({ wasm: hasher, amount: String(depositAmount), keypair: kp, index: 0, mintAddress: WRAPPED_SOL_MINT }),
  new Utxo({ wasm: hasher, amount: "0", keypair: kp, index: 1, mintAddress: WRAPPED_SOL_MINT }),
]
const ct1 = await enc.encryptUtxo(outputs[0])
const ct2 = await enc.encryptUtxo(outputs[1])
const extDataHash = getExtDataHash({
  recipient: "11111111111111111111111111111111",
  extAmount: depositAmount,
  encryptedOutput1: ct1,
  encryptedOutput2: ct2,
  fee: 0,
  feeRecipient: "11111111111111111111111111111111",
  mintAddress: WRAPPED_SOL_MINT,
})

const input = {
  root: "0",
  inputNullifier: await Promise.all(inputs.map((x) => x.getNullifier())),
  outputCommitment: outputs.map((x) => x.getCommitment()),
  publicAmount: String(depositAmount),
  extDataHash,
  inAmount: inputs.map((x) => x.amount.toString(10)),
  inPrivateKey: inputs.map((x) => x.keypair.privkey),
  inBlinding: inputs.map((x) => x.blinding.toString(10)),
  inPathIndices: [0, 0],
  inPathElements: [dummyPath, dummyPath],
  outAmount: outputs.map((x) => x.amount.toString(10)),
  outBlinding: outputs.map((x) => x.blinding.toString(10)),
  outPubkey: outputs.map((x) => x.keypair.pubkey),
  mintAddress: WRAPPED_SOL_MINT,
}

const t0 = Date.now()
await wtns.calculate(utils.stringifyBigInts(input), `${CIRCUIT}/transaction2.wasm`, "/tmp/bench/witness.wtns")
console.log(`witness (snarkjs wtns.calculate): ${Date.now() - t0}ms -> /tmp/bench/witness.wtns`)
writeFileSync("/tmp/bench/input.json", JSON.stringify(input, null, 2))
console.log("input dumped -> /tmp/bench/input.json")
