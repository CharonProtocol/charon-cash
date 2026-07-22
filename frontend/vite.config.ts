import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))
const require = createRequire(import.meta.url)
// The polyfill plugin injects `import ... from "vite-plugin-node-polyfills/shims/*"` into
// files that use Buffer/process/global — including the linked SDK package, which can't
// resolve those bare paths from its own context. Alias them to the real shim files.
const shim = (name: string) => {
  try {
    return require.resolve(`vite-plugin-node-polyfills/shims/${name}`)
  } catch {
    return undefined
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'util', 'assert', 'path'],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  resolve: {
    alias: Object.fromEntries(
      [['@', srcDir], ['buffer', shim('buffer')], ['vite-plugin-node-polyfills/shims/buffer', shim('buffer')]].filter(
        ([, v]) => v,
      ),
    ),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/health': { target: 'http://localhost:8080', changeOrigin: true },
      '/indexer': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})

