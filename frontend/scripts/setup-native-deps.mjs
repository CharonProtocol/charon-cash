// Reproduces native artifacts the client SDK needs at runtime:
// - @lightprotocol/hasher.rs browser wasm (shipped in dist/, referenced from dist/browser-fat/es/)
// - public/circuit/transaction2.{zkey,graph}, fetched by the in-browser prover
// Run automatically on `postinstall`. Safe to re-run.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const circuits = "../programs/privacy-cash/artifacts/circuits"
if (existsSync(path.join(circuits, "transaction2.graph"))) {
  mkdirSync("public/circuit", { recursive: true })
  rmSync("public/circuit/transaction2.wasm", { force: true })
  for (const f of ["transaction2.zkey", "transaction2.graph"]) {
    copyFileSync(path.join(circuits, f), path.join("public/circuit", f))
  }
  console.log("[setup] copied transaction2.{zkey,graph} -> public/circuit/")
}

// hasher.rs may be in frontend/node_modules OR hoisted to the workspace root (../node_modules)
const hasherDist = [
  "node_modules/@lightprotocol/hasher.rs/dist",
  "../node_modules/@lightprotocol/hasher.rs/dist",
].find((p) => existsSync(path.join(p, "light_wasm_hasher_bg.wasm")))
if (hasherDist) {
  for (const [src, dst] of [
    ["light_wasm_hasher_bg.wasm", "browser-fat/es/light_wasm_hasher_bg.wasm"],
    ["hasher_wasm_simd_bg.wasm", "browser-fat/es/hasher_wasm_simd_bg.wasm"],
  ]) {
    const from = path.join(hasherDist, src)
    if (existsSync(from)) {
      copyFileSync(from, path.join(hasherDist, dst))
      console.log(`[setup] copied ${src} -> browser-fat/es/`)
    }
  }
}
