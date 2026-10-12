import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const require = createRequire(import.meta.url);

const polyfillsRoot = dirname(
  dirname(require.resolve("vite-plugin-node-polyfills")),
);
// Always use the ESM build of the plugin shims (require.resolve returns .cjs).
const shim = (name: string) =>
  join(polyfillsRoot, "shims", name, "dist", "index.js");

// Cross-origin isolation unlocks SharedArrayBuffer, so the SDK loads the threaded
// prover. Production hosting must send the same headers (see public/_headers).
// Every cross-origin subresource then needs CORS or CORP (fonts use crossorigin).
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: [
        "buffer",
        "process",
        "stream",
        "util",
        "assert",
        "path",
        "crypto",
      ],
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      "@": srcDir,
      buffer: require.resolve("buffer/"),
      process: require.resolve("process/browser.js"),
      "vite-plugin-node-polyfills/shims/buffer": shim("buffer"),
      "vite-plugin-node-polyfills/shims/process": shim("process"),
      "vite-plugin-node-polyfills/shims/global": shim("global"),
    },
  },
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    include: [
      "buffer",
      "process",
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/process",
      "vite-plugin-node-polyfills/shims/global",
    ],
    // Pre-bundling would break the SDK's `new URL('./prover-worker.js', import.meta.url)`
    // and the wasm-bindgen `new URL('*_bg.wasm', import.meta.url)` lookups.
    exclude: ["charonprotocol-sdk"],
    esbuildOptions: {
      define: { global: "globalThis" },
    },
  },
  build: {
    commonjsOptions: { transformMixedEsModules: true },
  },
  // The prover worker is an ES module (it imports the wasm-bindgen glue).
  worker: { format: "es" },
  preview: { headers: isolationHeaders },
  server: {
    host: "0.0.0.0",
    port: 5173,
    headers: isolationHeaders,
    fs: { allow: [".."] },
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      "/health": { target: "http://localhost:8080", changeOrigin: true },
      "/indexer": { target: "http://localhost:8080", changeOrigin: true },
    },
    allowedHosts: ["52a7-103-98-159-175.ngrok-free.app"],
  },
});
