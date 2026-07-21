// Reproduces native artifacts the client SDK needs at runtime:
//   1. @lightprotocol/hasher.rs browser wasm (shipped in dist/, referenced from dist/browser-fat/es/)
//   2. the circom transaction2.{wasm,zkey} circuit (copied from the sibling
//      privacy-cash-sdk clone into public/circuit/)
// Run automatically on `postinstall`. Safe to re-run.
import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import path from "node:path"

const root = "node_modules/@lightprotocol/hasher.rs/dist"
for (const [src, dst] of [
  ["light_wasm_hasher_bg.wasm", "browser-fat/es/light_wasm_hasher_bg.wasm"],
  ["hasher_wasm_simd_bg.wasm", "browser-fat/es/hasher_wasm_simd_bg.wasm"],
]) {
  const from = `${root}/${src}`
  if (existsSync(from)) {
    copyFileSync(from, `${root}/${dst}`)
    console.log(`[setup] copied ${src} -> browser-fat/es/`)
  }
}

const sdkCircuit = path.join("..", "privacy-cash-sdk", "circuit2")
const publicCircuit = path.join("public", "circuit")
if (existsSync(sdkCircuit)) {
  mkdirSync(publicCircuit, { recursive: true })
  for (const f of ["transaction2.wasm", "transaction2.zkey"]) {
    const from = path.join(sdkCircuit, f)
    if (existsSync(from)) {
      copyFileSync(from, path.join(publicCircuit, f))
      console.log(`[setup] copied ${f} -> public/circuit/`)
    }
  }
} else {
  console.warn(
    "[setup] privacy-cash-sdk/ not found as a sibling — skipping circuit copy.\n" +
      "        Clone https://github.com/Privacy-Cash/privacy-cash-sdk next to this repo and re-run.",
  )
}
