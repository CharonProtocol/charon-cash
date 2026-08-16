// Builds the self-contained WebView bridge:
//   1. Bundles the privacy-cash-sdk (snarkjs + Poseidon WASM + crypto.subtle
//      consumers) into one browser-loadable IIFE assigned to window.PrivacyCashSDK.
//   2. Inlines that bundle + the in-page RPC host into a single bridge.html.
//   3. Emits bridge-html.ts exporting the HTML as a string for RN to import.
//
// Run from mobile/:  node bridge/build-bridge.mjs   (or `bun run build:bridge`)
//
// Prereq: the published SDK must be installed in mobile/node_modules:
//   cd mobile && bun install   (after `npm view privacy-cash-sdk version` shows the target)

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "dist");
const SDK_ENTRY = resolve(__dirname, "sdk-entry.ts");

// Tiny entry that re-exports the SDK surface the bridge needs, onto a global.
// We also add PublicKey + VersionedTransaction (@solana/web3.js) — the SDK uses
// them internally but does not re-export them. bridge-host.js needs PublicKey for
// the signer, and VersionedTransaction to serialize/deserialize the deposit tx
// that round-trips through the native wallet (signTransaction bridging).
//
// The polyfill import MUST be first: the SDK references the `Buffer` Node global
// unguarded at module-eval time, and the browser WebView has no Buffer. esbuild
// evaluates side-effect imports in source order, so bridge-polyfill installs
// Buffer/process/global before any SDK module's top-level code runs.
const ENTRY_SRC = `
import "./bridge-polyfill";
import * as sdk from "privacy-cash-sdk";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
(globalThis as any).PrivacyCashSDK = Object.assign(Object.create(null), sdk, { PublicKey, VersionedTransaction });
`;
writeFileSync(SDK_ENTRY, ENTRY_SRC);

mkdirSync(OUT, { recursive: true });

// Resolve privacy-cash-sdk from the mobile app's own node_modules — the mobile
// app is a standalone consumer of the PUBLISHED npm SDK (declared in
// package.json as "privacy-cash-sdk": "^0.1.x"), NOT the monorepo workspace.
// Bundling the npm version keeps web + mobile on the identical, pinned release.
const mobileRequire = createRequire(import.meta.url);
let sdkMain, sdkVersion;
try {
  sdkMain = mobileRequire.resolve("privacy-cash-sdk");
  // The SDK's "exports" map exposes only "." (not "./package.json"), so derive
  // the package.json path from the resolved main (main is ./dist/index.js).
  const sdkPkgPath = resolve(sdkMain, "..", "..", "package.json");
  sdkVersion = JSON.parse(readFileSync(sdkPkgPath, "utf8")).version;
} catch {
  console.error("\n✖ privacy-cash-sdk is not installed in mobile/node_modules.");
  console.error("  The mobile app consumes the SDK from npm. Install it first:");
  console.error("    cd mobile && bun install");
  console.error("  (verify the target is published:  npm view privacy-cash-sdk version)\n");
  process.exit(1);
}

console.log(`→ bundling privacy-cash-sdk@${sdkVersion} (npm) from`, sdkMain);

const bundle = await build({
  entryPoints: [SDK_ENTRY],
  bundle: true,
  format: "iife",
  globalName: "__pcash_sdk_iife__",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  minify: true,
  write: false,
  logLevel: "warning",
  // Inline WASM assets as data URIs so the page is fully self-contained.
  loader: { ".wasm": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "globalThis",
  },
  // Pin the SDK to the resolved npm main so esbuild bundles exactly that file.
  alias: { "privacy-cash-sdk": sdkMain },
  // The SDK is ESM ("type":"module"); esbuild handles it, but allow CJS deps.
  mainFields: ["browser", "module", "main"],
  conditions: ["browser", "import", "default"],
});

const sdkJs = bundle.outputFiles[0].text;
// The entry is a throwaway (resolved via the esbuild alias, not node resolution);
// remove it so it doesn't linger as a stray source file or trip tsc.
try { unlinkSync(SDK_ENTRY); } catch {}
const hostJs = readFileSync(resolve(__dirname, "bridge-host.js"), "utf8");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>pcash-bridge</title>
<style>html,body{background:#0C0E12;margin:0;padding:0}</style>
</head>
<body>
<script>
// ---- privacy-cash-sdk bundle (inlined) ----
${sdkJs}
</script>
<script>
// ---- in-page RPC host ----
${hostJs}
</script>
</body>
</html>`;

writeFileSync(resolve(OUT, "bridge.html"), html);

// Export the HTML as a JSON string literal so RN can import it directly.
//
// CRITICAL: hermesc (RN's JS->bytecode compiler, hermesEnabled=true) silently
// DROPS any string whose RUNTIME VALUE contains a non-ASCII byte -- the whole
// literal just vanishes from the bytecode. This entire HTML is exported as ONE
// string, so a single stray Unicode char (an em-dash/arrow inside the SDK's
// minified bundle) erases the WHOLE bridge -> the WebView loads empty HTML,
// never posts "ready", bridgeReady stays false, the auto-load never runs ->
// balance is 0 with no error banner.
//
// NOTE: \uXXXX escapes do NOT help -- hermesc decodes them back to the original
// char before storing, so the value is still non-ASCII and still gets dropped.
// The only fix is to REPLACE each non-ASCII char with an ASCII equivalent in the
// content itself. These chars only ever live inside the SDK's error messages and
// comments, so swapping e.g. em-dash -> "--" is functionally harmless. The
// emitted .ts is then a pure-ASCII literal whose VALUE is ASCII, which hermesc
// keeps verbatim.
const ASCII_MAP = {
  "—": "--", "–": "-", "…": "...", "→": "->",
  "←": "<-", "↔": "<->", "·": ".", "×": "x",
  "’": "'", "‘": "'", "“": '"', "”": '"', " ": " ",
};
const asciiHtml = html.replace(/[^\x00-\x7F]/g, (c) => ASCII_MAP[c] ?? "?");
const ts = `// AUTO-GENERATED by bridge/build-bridge.mjs. Do not edit.
/* eslint-disable */
export default ${JSON.stringify(asciiHtml)};
`;
writeFileSync(resolve(OUT, "bridge-html.ts"), ts);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✓ wrote bridge/dist/bridge.html (${kb} KB)`);
console.log(`✓ wrote bridge/dist/bridge-html.ts`);
console.log(`  The SDK IIFE exposes window.PrivacyCashSDK.`);
