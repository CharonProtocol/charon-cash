// Reproduces native artifacts the client SDK needs at runtime:
// @lightprotocol/hasher.rs browser wasm (shipped in dist/, referenced from dist/browser-fat/es/)
// Run automatically on `postinstall`. Safe to re-run.
import { copyFileSync, existsSync } from "node:fs"
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
