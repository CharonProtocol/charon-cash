let glue = null;
/**
 * Threads need SharedArrayBuffer, which browsers only expose to cross-origin
 * isolated pages (COOP `same-origin` + COEP `require-corp`), and a Worker
 * constructor to spawn rayon's threads from.
 */
function threadBudget(requested) {
    if (requested !== undefined && requested <= 1)
        return 1;
    const g = globalThis;
    if (!g.crossOriginIsolated || typeof SharedArrayBuffer === "undefined" || typeof Worker === "undefined") {
        return 1;
    }
    const cores = Math.max(1, g.navigator?.hardwareConcurrency ?? 1);
    return Math.min(requested ?? cores, cores);
}
async function loadGlue(opts) {
    const budget = opts.wasm === undefined ? threadBudget(opts.threads) : 1;
    let threadError;
    if (budget > 1) {
        try {
            const mt = await import("../prover-wasm-mt/privacy_cash_prover.js");
            await mt.default();
            await mt.initThreadPool(budget);
            return { mod: mt, threads: mt.proverThreads() };
        }
        catch (e) {
            threadError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
    }
    const st = await import("../prover-wasm/privacy_cash_prover.js");
    await st.default(opts.wasm === undefined ? undefined : { module_or_path: opts.wasm });
    return { mod: st, threads: 1, threadError };
}
/**
 * Instantiates the prover wasm (once per realm; threaded when the page allows
 * it) and parses the proving key and witness graph. Keep the returned prover.
 */
export async function createWasmProver(artifacts, opts = {}) {
    glue ??= loadGlue(opts).catch((e) => {
        glue = null;
        throw e;
    });
    const { mod, threads, threadError } = await glue;
    return { prover: new mod.WasmProver(artifacts.zkey, artifacts.graph), threads, threadError };
}
