import { execFile } from "node:child_process"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { wtns } from "snarkjs"
import { utils } from "ffjavascript"

import type { ProverOverride } from "privacy-cash-sdk"

const execFileAsync = promisify(execFile)

export interface RapidsnarkProverOptions {
  /** Path to the rapidsnark `prover` binary. */
  proverBin: string
  /** Path to the proving key (transaction2.zkey). */
  zkeyPath: string
  /** Path to the witness calculator wasm (transaction2.wasm). */
  wasmPath: string
}

/**
 * Native groth16 prover backed by the rapidsnark C++ binary. The witness is
 * still calculated in-process via the circuit wasm (~100ms); only the proving
 * step moves out of JS (~1s native vs ~9.4s snarkjs). Inject into the SDK with
 * `setProver(createRapidsnarkProver(...))`. Server/engine runners only — the
 * browser keeps the default snarkjs prover.
 */
export function createRapidsnarkProver(
  opts: RapidsnarkProverOptions,
): ProverOverride {
  return async (input) => {
    const dir = await mkdtemp(join(tmpdir(), "pc-proof-"))
    try {
      const witnessPath = join(dir, "input.wtns")
      const proofPath = join(dir, "proof.json")
      const publicPath = join(dir, "public.json")
      await wtns.calculate(
        utils.stringifyBigInts(input) as Record<string, unknown>,
        opts.wasmPath,
        witnessPath,
      )
      // The witness embeds the input notes' private keys. The mkdtemp dir is
      // already 0700; pin the file itself to owner-only so it stays private
      // even if the process dies before the finally-cleanup runs.
      await chmod(witnessPath, 0o600)
      await execFileAsync(opts.proverBin, [
        opts.zkeyPath,
        witnessPath,
        proofPath,
        publicPath,
      ])
      const [proof, publicSignals] = await Promise.all([
        readFile(proofPath, "utf8"),
        readFile(publicPath, "utf8"),
      ])
      const parsed = JSON.parse(proof)
      return {
        proof: { ...parsed, curve: parsed.curve ?? "bn128" },
        publicSignals: JSON.parse(publicSignals),
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
