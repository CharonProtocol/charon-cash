import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { cloudflare } from "@cloudflare/vite-plugin";

const require = createRequire(import.meta.url)
const polyfillsRoot = dirname(dirname(require.resolve("vite-plugin-node-polyfills")))
const shim = (name: string) => join(polyfillsRoot, "shims", name, "dist", "index.js")

export default defineConfig({
  plugins: [react(), tailwindcss(), nodePolyfills({
    include: ["buffer", "process", "stream", "util", "assert", "path", "crypto"],
    globals: { Buffer: true, process: true, global: true },
    protocolImports: true,
  }), cloudflare()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      buffer: require.resolve("buffer/"),
      process: require.resolve("process/browser.js"),
      "vite-plugin-node-polyfills/shims/buffer": shim("buffer"),
      "vite-plugin-node-polyfills/shims/process": shim("process"),
      "vite-plugin-node-polyfills/shims/global": shim("global"),
    },
  },
  define: { global: "globalThis" },
  optimizeDeps: {
    include: [
      "buffer",
      "process",
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/process",
      "vite-plugin-node-polyfills/shims/global",
    ],
    esbuildOptions: { define: { global: "globalThis" } },
  },
  build: { commonjsOptions: { transformMixedEsModules: true } },
  server: { host: "0.0.0.0", port: 5174, fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
})