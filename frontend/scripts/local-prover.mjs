// Configures the SDK's in-thread wasm prover for Bun scripts: artifacts come
// from the repo instead of `/circuit/` over HTTP. Import before calling `prove`.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { configureProver, verifyArtifact } from "privacy-cash-sdk"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const circuits = path.join(repoRoot, "programs/privacy-cash/artifacts/circuits")

configureProver({
  inThread: true,
  wasm: readFileSync(path.join(repoRoot, "sdk/prover-wasm/privacy_cash_prover_bg.wasm")),
  loadArtifacts: async () => {
    const zkey = new Uint8Array(readFileSync(path.join(circuits, "transaction2.zkey")))
    const graph = new Uint8Array(readFileSync(path.join(circuits, "transaction2.graph")))
    await verifyArtifact("zkey", zkey)
    await verifyArtifact("graph", graph)
    return { zkey, graph }
  },
})
