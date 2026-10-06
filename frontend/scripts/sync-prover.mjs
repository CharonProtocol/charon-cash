// Copies the sdk's prover engine into public/ as raw static modules.
// The wasm-bindgen glue and rayon's self-spawn break when served through the
// bundler (dev transform / prod chunks mangle the import.meta.url lookups),
// so the prover loads un-transformed from /prover/, /prover-wasm*/ and the
// artifacts from /circuit/ — the same layout the payroll app shipped.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkDist = join(root, "..", "sdk", "dist");
const pub = join(root, "public");

mkdirSync(join(pub, "prover"), { recursive: true });
mkdirSync(join(pub, "circuit"), { recursive: true });
for (const f of ["prover-worker.js", "prover-core.js", "circuit-artifacts.js"])
  cpSync(join(sdkDist, f), join(pub, "prover", f));
for (const d of ["prover-wasm", "prover-wasm-mt"])
  cpSync(join(sdkDist, d), join(pub, d), { recursive: true });
for (const f of ["transaction2.zkey", "transaction2.graph"])
  cpSync(join(sdkDist, "circuits", f), join(pub, "circuit", f));
console.log("synced prover engine + artifacts into public/");
