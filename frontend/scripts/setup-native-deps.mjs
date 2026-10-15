// Reproduces native artifacts the client SDK needs at runtime:
//   1. @lightprotocol/hasher.rs browser wasm (shipped in dist/, referenced from dist/browser-fat/es/)
//   2. the circom transaction2.{wasm,zkey} circuit (copied from the sibling
//      privacy-cash-sdk clone into public/circuit/)
// Run automatically on `postinstall`. Safe to re-run.
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

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

// Circuit: the sibling privacy-cash-sdk clone when present, else the copy
// tracked in this repo (same files) — a fresh clone works without the sibling.
const circuitSrcs = [
  path.join("..", "..", "privacy-cash-sdk", "circuit2"),
  path.join("..", "privacy-cash-sdk", "circuit2"),
  path.join("..", "programs", "privacy-cash", "artifacts", "circuits"),
]
const publicCircuit = path.join("public", "circuit")
mkdirSync(publicCircuit, { recursive: true })
for (const f of ["transaction2.wasm", "transaction2.zkey"]) {
  const src = circuitSrcs.find((d) => existsSync(path.join(d, f)))
  if (src) {
    copyFileSync(path.join(src, f), path.join(publicCircuit, f))
    console.log(`[setup] copied ${f} from ${src} -> public/circuit/`)
  } else {
    console.warn(`[setup] ${f} not found in ${circuitSrcs.join(", ")} — skipping`)
  }
}
