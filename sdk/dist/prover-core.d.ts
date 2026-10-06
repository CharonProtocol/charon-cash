import type { WasmProver } from "../prover-wasm/privacy_cash_prover.js";
import type { CircuitArtifacts } from "./circuit-artifacts.js";
/** Anything wasm-bindgen's `init` accepts: a URL, a Response, or raw bytes. */
export type ProverWasmSource = URL | string | Response | BufferSource | WebAssembly.Module;
export interface WasmProverOptions {
    /** Single-threaded wasm bytes or URL; forces the single-threaded build. */
    wasm?: ProverWasmSource;
    /** Max rayon threads for the threaded build; `1` forces single-threaded. Default: all cores. */
    threads?: number;
}
export interface LoadedProver {
    prover: WasmProver;
    /** Threads the prover actually runs on (1 = single-threaded build). */
    threads: number;
    /** Why the threaded build was tried and not used, if it was. */
    threadError?: string;
}
/**
 * Instantiates the prover wasm (once per realm; threaded when the page allows
 * it) and parses the proving key and witness graph. Keep the returned prover.
 */
export declare function createWasmProver(artifacts: CircuitArtifacts, opts?: WasmProverOptions): Promise<LoadedProver>;
export type { WasmProver };
//# sourceMappingURL=prover-core.d.ts.map