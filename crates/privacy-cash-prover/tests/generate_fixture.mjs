// Deterministic dummy-deposit circuit JSON for POST /api/prove checks.
// Run from repo root:
//   NODE_PATH=frontend/node_modules bun crates/privacy-cash-prover/tests/generate_fixture.mjs
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { WasmFactory } from "@lightprotocol/hasher.rs"
import {
  EncryptionService,
  Keypair,
  Utxo,
  getExtDataHash,
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

const FIELD = BigInt(FIELD_SIZE.toString())
const mod = (x) => ((x % FIELD) + FIELD) % FIELD
const here = dirname(fileURLToPath(import.meta.url))

function toHex(bytes) {
  let h = "0x"
  for (const b of bytes) h += b.toString(16).padStart(2, "0")
  return h
}

const wasm = await WasmFactory.getInstance()
const enc = new EncryptionService()
enc.deriveFromSignature(new Uint8Array(64).fill(9))
const kp = new Keypair(enc.utxoPrivateKey, wasm)
const dummyPath = new Array(MERKLE_TREE_DEPTH).fill("0")
const inputs = [
  new Utxo({ wasm, keypair: kp, amount: "0", blinding: "1", index: 0 }),
  new Utxo({ wasm, keypair: kp, amount: "0", blinding: "2", index: 0 }),
]
const depositAmount = 10_000_000
const outputs = [
  new Utxo({
    wasm,
    amount: String(depositAmount),
    keypair: kp,
    blinding: "3",
    index: 0,
    mintAddress: WRAPPED_SOL_MINT,
  }),
  new Utxo({
    wasm,
    amount: "0",
    keypair: kp,
    blinding: "4",
    index: 1,
    mintAddress: WRAPPED_SOL_MINT,
  }),
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

const json = {
  root: "0",
  inputNullifier: await Promise.all(inputs.map((x) => x.getNullifier())),
  outputCommitment: outputs.map((x) => x.getCommitment()),
  publicAmount: mod(BigInt(depositAmount)).toString(),
  extDataHash: toHex(extDataHash),
  inAmount: inputs.map((x) => x.amount.toString(10)),
  inPrivateKey: inputs.map((x) => x.keypair.privkey.toString(10)),
  inBlinding: inputs.map((x) => x.blinding.toString(10)),
  inPathIndices: [0, 0],
  inPathElements: [dummyPath, dummyPath],
  outAmount: outputs.map((x) => x.amount.toString(10)),
  outBlinding: outputs.map((x) => x.blinding.toString(10)),
  outPubkey: outputs.map((x) => x.keypair.pubkey.toString(10)),
  mintAddress: WRAPPED_SOL_MINT,
}

const out = join(here, "fixtures", "deposit_circuit.json")
writeFileSync(out, JSON.stringify(json, null, 2) + "\n")
console.log("wrote", out)
