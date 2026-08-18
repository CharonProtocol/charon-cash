import { defineConfig } from "vitest/config"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const polyfillsRoot = dirname(dirname(require.resolve("vite-plugin-node-polyfills")))
const shim = (name: string) => join(polyfillsRoot, "shims", name, "dist", "index.js")

export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ["buffer", "process", "stream", "util", "assert", "path", "crypto"],
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
    }),
  ],
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
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
})
