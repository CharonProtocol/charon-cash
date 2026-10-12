// Builds the two wasm variants of crates/privacy-cash-prover:
//   prover-wasm/     single-threaded; stable Rust; runs anywhere
//   prover-wasm-mt/  rayon over Web Workers; nightly Rust (atomics + build-std);
//                    used only when the page is cross-origin isolated (COOP/COEP)
// Usage: node scripts/build-prover.mjs [st|mt]   (default: both)
// Env: PROVER_NIGHTLY (default "nightly") picks the toolchain for the mt build.
import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sdk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const crate = path.resolve(sdk, "../crates/privacy-cash-prover")
const which = process.argv[2] ?? "both"
const nightly = process.env.PROVER_NIGHTLY ?? "nightly"

function run(cmd, args, env = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const r = spawnSync(cmd, args, { cwd: crate, stdio: "inherit", env: { ...process.env, ...env } })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function wasmPack(outDir, cargoArgs) {
  return [
    "build", "--release", "--target", "web", "--no-pack",
    "--out-dir", path.join(sdk, outDir), "--out-name", "privacy_cash_prover",
    "--", "--no-default-features", ...cargoArgs,
  ]
}

if (which === "both" || which === "st") {
  run("wasm-pack", wasmPack("prover-wasm", ["--features", "wasm"]))
  rmSync(path.join(sdk, "prover-wasm/.gitignore"), { force: true })
}

if (which === "both" || which === "mt") {
  const probe = spawnSync("rustup", ["run", nightly, "rustc", "--version"], { encoding: "utf8" })
  if (probe.status !== 0) {
    console.error(
      `The threaded prover needs a nightly toolchain with rust-src:\n` +
        `  rustup toolchain install ${nightly} --component rust-src --target wasm32-unknown-unknown\n` +
        `or build only the single-threaded variant: node scripts/build-prover.mjs st`,
    )
    process.exit(1)
  }
  const targetRoot = process.env.CARGO_TARGET_DIR ?? path.join(crate, "target")
  run("rustup", ["run", nightly, "wasm-pack", ...wasmPack("prover-wasm-mt", [
    "--features", "wasm-threads", "-Z", "build-std=panic_abort,std",
  ])], {
    // Shared, imported memory plus the TLS exports wasm-bindgen's thread transform
    // needs; rustc does not add these for +atomics on its own. 512 MiB max: large
    // shared-memory reservations fail on iOS, and proving peaks far below this.
    RUSTFLAGS: [
      "-C target-feature=+atomics,+bulk-memory,+mutable-globals",
      "-C link-arg=--shared-memory",
      "-C link-arg=--import-memory",
      "-C link-arg=--max-memory=536870912",
      "-C link-arg=--export=__wasm_init_tls",
      "-C link-arg=--export=__tls_size",
      "-C link-arg=--export=__tls_align",
      "-C link-arg=--export=__tls_base",
    ].join(" "),
    // Separate dir: the atomics RUSTFLAGS would otherwise invalidate the st build's cache.
    CARGO_TARGET_DIR: path.join(targetRoot, "wasm-threads"),
  })
  const out = path.join(sdk, "prover-wasm-mt")
  rmSync(path.join(out, ".gitignore"), { force: true })
  // wasm-bindgen-rayon's worker imports its package as `../../..`, which only
  // resolves when a bundler finds a package.json there. Point it at the file.
  for (const dir of readdirSync(path.join(out, "snippets"))) {
    const helper = path.join(out, "snippets", dir, "src/workerHelpers.js")
    const src = readFileSync(helper, "utf8")
    const patched = src.replace("import('../../..')", "import('../../../privacy_cash_prover.js')")
    if (patched === src) throw new Error(`workerHelpers.js layout changed: ${helper}`)
    writeFileSync(helper, patched)
  }
}
