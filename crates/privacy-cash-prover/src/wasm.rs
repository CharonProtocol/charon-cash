//! wasm-bindgen surface used by `sdk/src/prover-worker.ts`.

use wasm_bindgen::prelude::*;

use crate::Prover;

/// `initThreadPool(n)`: must resolve before the first proof. Exported to JS by
/// wasm-bindgen-rayon's own `#[wasm_bindgen]`; this `use` keeps the crate linked.
#[cfg(feature = "wasm-threads")]
#[allow(unused_imports)]
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

/// Rayon worker count, or 1 in the single-threaded build.
#[wasm_bindgen(js_name = proverThreads)]
pub fn prover_threads() -> usize {
    #[cfg(feature = "parallel")]
    return rayon::current_num_threads();
    #[cfg(not(feature = "parallel"))]
    return 1;
}

#[wasm_bindgen]
pub struct WasmProver {
    inner: Prover,
}

#[wasm_bindgen]
impl WasmProver {
    /// Parses `transaction2.zkey` and `transaction2.graph` (both already
    /// SHA-256 checked by the caller).
    #[wasm_bindgen(constructor)]
    pub fn new(zkey: &[u8], graph: &[u8]) -> Result<WasmProver, JsError> {
        let inner = Prover::new(zkey, graph).map_err(|e| JsError::new(&format!("{e:#}")))?;
        Ok(WasmProver { inner })
    }

    /// Circuit-input JSON in, `{proof_a, proof_b, proof_c, public_signals}` JSON out.
    pub fn prove(&self, input_json: &str) -> Result<String, JsError> {
        let response = self
            .inner
            .prove_json(input_json)
            .map_err(|e| JsError::new(&format!("{e:#}")))?;
        serde_json::to_string(&response).map_err(|e| JsError::new(&e.to_string()))
    }
}
