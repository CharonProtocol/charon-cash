import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))
const require = createRequire(import.meta.url)

const polyfillsRoot = dirname(dirname(require.resolve('vite-plugin-node-polyfills')))
// Always use the ESM build of the plugin shims (require.resolve returns .cjs).
const shim = (name: string) => join(polyfillsRoot, 'shims', name, 'dist', 'index.js')

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ['buffer', 'process', 'stream', 'util', 'assert', 'path', 'crypto'],
      globals: { Buffer: true, process: true, global: true },
      protocolImports: true,
    }),
  ],
  resolve: {
    alias: {
      '@': srcDir,
      buffer: require.resolve('buffer/'),
      process: require.resolve('process/browser.js'),
      'vite-plugin-node-polyfills/shims/buffer': shim('buffer'),
      'vite-plugin-node-polyfills/shims/process': shim('process'),
      'vite-plugin-node-polyfills/shims/global': shim('global'),
    },
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: [
      'buffer',
      'process',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/process',
      'vite-plugin-node-polyfills/shims/global',
    ],
    // The SDK is a workspace-linked ESM package (sdk/ -> node_modules). Vite
    // pre-bundling it snapshots dist at first run; since the version string
    // doesn't change on every SDK rebuild (e.g. adding transferSOL), the stale
    // snapshot kept being served and methods went missing at runtime
    // ("client.transferSOL is not a function"). Excluding it makes Vite serve
    // the linked source directly, so SDK rebuilds are always picked up.
    exclude: ['privacy-cash-sdk'],
    esbuildOptions: {
      define: { global: 'globalThis' },
    },
  },
  build: {
    commonjsOptions: { transformMixedEsModules: true },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/health': { target: 'http://localhost:8080', changeOrigin: true },
      '/indexer': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
