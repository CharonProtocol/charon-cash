// Deterministic circuit-input fixtures for the prover tests:
//   deposit_circuit.json   SOL deposit, dummy inputs, zero paths
//   withdraw_circuit.json  SOL withdraw spending leaf 1 of a 2-leaf tree (real path)
//   spl_circuit.json       SPL (USDC mint) deposit
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
  getMintAddressField,
  FIELD_SIZE,
  MERKLE_TREE_DEPTH,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

const FIELD = BigInt(FIELD_SIZE.toString())
const mod = (x) => ((x % FIELD) + FIELD) % FIELD
const here = dirname(fileURLToPath(import.meta.url))
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const NOBODY = "11111111111111111111111111111111"

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
const hash2 = (a, b) => wasm.poseidonHashString([a, b])

/** Root and sibling path for `leaves[index]` in a depth-26 tree of zero leaves. */
function merklePath(leaves, index) {
  const path = []
  let level = leaves.slice()
  let zero = "0"
  let i = index
  for (let d = 0; d < MERKLE_TREE_DEPTH; d++) {
    const sib = i ^ 1
    path.push(sib < level.length ? level[sib] : zero)
    const next = []
    for (let j = 0; j < level.length; j += 2) {
      next.push(hash2(level[j], j + 1 < level.length ? level[j + 1] : zero))
    }
    level = next
    zero = hash2(zero, zero)
    i >>= 1
  }
  return { root: level[0], path }
}

async function circuitJson({ root, inputs, outputs, paths, extAmount, fee, mint }) {
  const ct1 = await enc.encryptUtxo(outputs[0])
  const ct2 = await enc.encryptUtxo(outputs[1])
  const extDataHash = getExtDataHash({
    recipient: NOBODY,
    extAmount,
    encryptedOutput1: ct1,
    encryptedOutput2: ct2,
    fee,
    feeRecipient: NOBODY,
    mintAddress: mint,
  })
  return {
    root,
    inputNullifier: await Promise.all(inputs.map((x) => x.getNullifier())),
    outputCommitment: outputs.map((x) => x.getCommitment()),
    publicAmount: mod(BigInt(extAmount) - BigInt(fee)).toString(),
    extDataHash: toHex(extDataHash),
    inAmount: inputs.map((x) => x.amount.toString(10)),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString(10)),
    inBlinding: inputs.map((x) => x.blinding.toString(10)),
    inPathIndices: inputs.map((x) => x.index),
    inPathElements: paths,
    outAmount: outputs.map((x) => x.amount.toString(10)),
    outBlinding: outputs.map((x) => x.blinding.toString(10)),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString(10)),
    mintAddress: getMintAddressField(mint),
  }
}

function write(name, json) {
  const out = join(here, "fixtures", name)
  writeFileSync(out, JSON.stringify(json, null, 2) + "\n")
  console.log("wrote", out)
}

const utxo = (o) => new Utxo({ wasm, keypair: kp, ...o })

// Deposit: two zero-amount dummy inputs, 0.01 SOL out.
const depositAmount = 10_000_000
const depositOut = [
  utxo({ amount: String(depositAmount), blinding: "3", index: 0 }),
  utxo({ amount: "0", blinding: "4", index: 1 }),
]
write(
  "deposit_circuit.json",
  await circuitJson({
    root: "0",
    inputs: [utxo({ amount: "0", blinding: "1" }), utxo({ amount: "0", blinding: "2" })],
    outputs: depositOut,
    paths: [dummyPath, dummyPath],
    extAmount: depositAmount,
    fee: 0,
    mint: WRAPPED_SOL_MINT,
  }),
)

// Withdraw: spend the 0.01 SOL note at leaf 1 (leaf 0 is another note), take
// 0.006 SOL out with a 0.0001 SOL fee, keep 0.0039 SOL as change.
const other = utxo({ amount: "5000", blinding: "7", index: 0 })
const spend = utxo({ amount: String(depositAmount), blinding: "3", index: 1 })
const { root, path } = merklePath([other.getCommitment(), spend.getCommitment()], 1)
const withdrawAmount = 6_000_000
const fee = 100_000
write(
  "withdraw_circuit.json",
  await circuitJson({
    root,
    inputs: [spend, utxo({ amount: "0", blinding: "8", index: 0 })],
    outputs: [
      utxo({ amount: String(depositAmount - withdrawAmount - fee), blinding: "9", index: 2 }),
      utxo({ amount: "0", blinding: "10", index: 3 }),
    ],
    paths: [path, dummyPath],
    extAmount: -withdrawAmount,
    fee,
    mint: WRAPPED_SOL_MINT,
  }),
)

// SPL deposit: 25 USDC (6 decimals) under the USDC mint field.
const splAmount = 25_000_000
write(
  "spl_circuit.json",
  await circuitJson({
    root: "0",
    inputs: [
      utxo({ amount: "0", blinding: "11", mintAddress: USDC }),
      utxo({ amount: "0", blinding: "12", mintAddress: USDC }),
    ],
    outputs: [
      utxo({ amount: String(splAmount), blinding: "13", index: 0, mintAddress: USDC }),
      utxo({ amount: "0", blinding: "14", index: 1, mintAddress: USDC }),
    ],
    paths: [dummyPath, dummyPath],
    extAmount: splAmount,
    fee: 0,
    mint: USDC,
  }),
)
