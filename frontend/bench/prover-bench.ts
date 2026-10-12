// Dev-server page that times the real browser path: SDK prove() -> Web Worker ->
// wasm. Open http://localhost:5173/bench/prover.html, or run
// `node frontend/bench/run-browser-bench.mjs` for headless Chrome.
import { Buffer } from 'buffer'

import deposit from '../../crates/privacy-cash-prover/tests/fixtures/deposit_circuit.json'
import withdraw from '../../crates/privacy-cash-prover/tests/fixtures/withdraw_circuit.json'

declare global {
  interface Window {
    __bench?: Record<string, unknown>
  }
}

const params = new URLSearchParams(location.search)
const runs = Number(params.get('runs') ?? 5)
const threads = params.has('threads') ? Number(params.get('threads')) : undefined
const ms = (t: number) => Math.round(performance.now() - t)
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function main() {
  // The SDK's Solana deps expect a global Buffer at import time.
  globalThis.Buffer ??= Buffer
  const { CIRCUIT_CACHE_NAME, configureProver, preloadProver, prove, proverThreads, terminateProver } =
    await import('charonprotocol-sdk')
  configureProver({ threads })
  await caches.delete(CIRCUIT_CACHE_NAME)

  const stage = (s: string) => (document.getElementById('out')!.textContent = s)
  stage('loading prover')
  let t = performance.now()
  await preloadProver()
  const coldLoad = ms(t)

  const proveTimes: number[] = []
  for (let i = 0; i < runs; i++) {
    stage(`proof ${i + 1}/${runs} (${proverThreads()} threads)`)
    t = performance.now()
    await prove(i % 2 === 0 ? withdraw : deposit)
    proveTimes.push(ms(t))
  }

  terminateProver()
  stage('reloading prover from cache')
  t = performance.now()
  await preloadProver()
  const cachedLoad = ms(t)
  t = performance.now()
  await prove(withdraw)
  const firstProveAfterCachedLoad = ms(t)

  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated,
    proverThreads: proverThreads(),
    coldLoadMs: coldLoad,
    cachedLoadMs: cachedLoad,
    proveMs: proveTimes,
    proveMedianMs: median(proveTimes),
    firstProveAfterCachedLoadMs: firstProveAfterCachedLoad,
  }
}

main().then(
  (r) => {
    window.__bench = r
    document.getElementById('out')!.textContent = JSON.stringify(r, null, 2)
    document.title = 'done'
  },
  (e) => {
    window.__bench = { error: String(e?.stack ?? e) }
    document.getElementById('out')!.textContent = String(e?.stack ?? e)
    document.title = 'error'
  },
)
