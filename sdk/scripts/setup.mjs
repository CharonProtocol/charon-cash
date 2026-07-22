// Copy @lightprotocol/hasher.rs browser wasm next to its JS (shipped in dist/,
// referenced from dist/browser-fat/es/). Same fix as the frontend's setup script.
import { copyFileSync, existsSync } from "node:fs"
const root = "node_modules/@lightprotocol/hasher.rs/dist"
for (const [src, dst] of [
  ["light_wasm_hasher_bg.wasm", "browser-fat/es/light_wasm_hasher_bg.wasm"],
  ["hasher_wasm_simd_bg.wasm", "browser-fat/es/hasher_wasm_simd_bg.wasm"],
]) {
  if (existsSync(`${root}/${src}`)) copyFileSync(`${root}/${src}`, `${root}/${dst}`)
}
