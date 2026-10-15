// Reproduces native artifacts the client SDK needs at runtime:
//   1. @lightprotocol/hasher.rs browser wasm (referenced from dist/browser-fat/es/)
//   2. the circom transaction2.{wasm,zkey} circuit (copied from ../frontend/public/circuit)
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

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

// public/circuit is tracked in git: only fill a missing file, never overwrite
// (a partial ../frontend/public/circuit used to crash the install).
const publicCircuit = path.join("public", "circuit")
const circuitSrcs = [
  path.join("..", "frontend", "public", "circuit"),
  path.join("..", "programs", "privacy-cash", "artifacts", "circuits"),
]
mkdirSync(publicCircuit, { recursive: true })
for (const f of ["transaction2.wasm", "transaction2.zkey"]) {
  if (existsSync(path.join(publicCircuit, f))) continue
  const src = circuitSrcs.find((d) => existsSync(path.join(d, f)))
  if (src) {
    copyFileSync(path.join(src, f), path.join(publicCircuit, f))
    console.log(`[setup] copied ${f} from ${src}`)
  } else {
    console.warn(`[setup] ${f} not found — restore it with: git checkout -- payroll/public/circuit`)
  }
}
