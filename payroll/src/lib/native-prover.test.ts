// @vitest-environment node
import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { WasmFactory } from "@lightprotocol/hasher.rs"
import { groth16, zKey } from "snarkjs"
import {
  EncryptionService,
  Keypair,
  Utxo,
  getExtDataHash,
  WRAPPED_SOL_MINT,
} from "privacy-cash-sdk"

import { createRapidsnarkProver } from "./native-prover"

const proverBin = process.env.RAPIDSNARK_BIN ?? "/tmp/rapidsnark-src/build_osx/src/prover"
const circuitDir = join(__dirname, "../../../frontend/public/circuit")
const zkeyPath = join(circuitDir, "transaction2.zkey")
const wasmPath = join(circuitDir, "transaction2.wasm")
const haveArtifacts =
  existsSync(proverBin) && existsSync(zkeyPath) && existsSync(wasmPath)

describe.skipIf(!haveArtifacts)("createRapidsnarkProver", () => {
  it("proves a valid deposit input natively and verifies against the vkey", async () => {
    const hasher = await WasmFactory.getInstance()
    const enc = new EncryptionService()
    enc.deriveFromSignature(new Uint8Array(64).fill(9))
    const kp = new Keypair(enc.utxoPrivateKey, hasher)

    const dummyPath = new Array(26).fill("0")
    const inputs = [
      new Utxo({ wasm: hasher, keypair: kp }),
      new Utxo({ wasm: hasher, keypair: kp }),
    ]
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
      encryptedOutput1: ct1 as unknown as Uint8Array,
      encryptedOutput2: ct2 as unknown as Uint8Array,
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
      inPrivateKey: inputs.map((x) => x.keypair!.privkey),
      inBlinding: inputs.map((x) => x.blinding.toString(10)),
      inPathIndices: [0, 0],
      inPathElements: [dummyPath, dummyPath],
      outAmount: outputs.map((x) => x.amount.toString(10)),
      outBlinding: outputs.map((x) => x.blinding.toString(10)),
      outPubkey: outputs.map((x) => x.keypair!.pubkey),
      mintAddress: WRAPPED_SOL_MINT,
    }

    const prove = createRapidsnarkProver({ proverBin, zkeyPath, wasmPath })
    const t0 = Date.now()
    const { proof, publicSignals } = await prove(input as unknown as Record<string, unknown>)
    const ms = Date.now() - t0

    expect(proof.protocol).toBe("groth16")
    expect(proof.curve).toBe("bn128")
    expect(publicSignals.length).toBe(7)

    const vkey = await zKey.exportVerificationKey(zkeyPath)
    expect(await groth16.verify(vkey, publicSignals, proof)).toBe(true)
    console.log(`rapidsnark prove: ${ms}ms`)
  }, 120_000)
})
