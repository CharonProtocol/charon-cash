const mode = new URL(self.location.href).searchParams.get('mode')
let prover
self.onmessage = async (e) => {
  const m = e.data
  if (m.type === 'init') {
    try {
      if (mode === 'mt') {
        const mod = await import(m.mtPath || './mt/privacy_cash_prover.js')
        await mod.default(); await mod.initThreadPool(m.threads)
        if (mod.setArkMsm) mod.setArkMsm(!!m.ark)
        prover = new mod.WasmProver(new Uint8Array(m.zkey), new Uint8Array(m.graph))
      } else {
        const mod = await import(m.stPath || './st/privacy_cash_prover.js')
        await mod.default(m.stWasm || './st/privacy_cash_prover_bg.wasm')
        if (mod.setArkMsm) mod.setArkMsm(!!m.ark)
        prover = new mod.WasmProver(new Uint8Array(m.zkey), new Uint8Array(m.graph))
      }
      self.postMessage({ type: 'ready' })
    } catch (err) { self.postMessage({ type: 'fatal', error: String(err?.stack ?? err) }) }
  } else {
    const t = performance.now()
    try { prover.prove(m.input); self.postMessage({ type: 'done', ms: performance.now() - t }) }
    catch (err) { self.postMessage({ type: 'fatal', error: String(err) }) }
  }
}
