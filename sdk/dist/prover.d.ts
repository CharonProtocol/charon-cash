import BN from "bn.js";
import { CharonProtocolError } from "./error.js";
import { type CircuitArtifacts } from "./circuit-artifacts.js";
import { type ProverWasmSource } from "./prover-core.js";
export declare class ProofGenError extends CharonProtocolError {
    constructor(message: string, options?: {
        cause: unknown;
    });
}
export type CircuitParams = {
    root: string;
    inputNullifier: string[];
    outputCommitment: string[];
    publicAmount: string;
    extDataHash: Uint8Array<ArrayBufferLike>;
    inAmount: string[];
    inPrivateKey: BN[];
    inBlinding: string[];
    inPathIndices: number[];
    inPathElements: string[][];
    outAmount: string[];
    outBlinding: string[];
    outPubkey: BN[];
    mintAddress: string;
};
export interface ProofBytes {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    root: number[];
    publicAmount: number[];
    extDataHash: number[];
    inputNullifiers: number[][];
    outputCommitments: number[][];
}
export interface Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
}
export interface ProverOptions {
    /** Where `transaction2.zkey` and `transaction2.graph` are served. Browsers: the app-hosted `/circuit/` static dir. Node/Bun: the sdk's own `circuits/` on disk. */
    circuitBaseUrl?: string;
    /**
     * Base dir serving the prover worker and wasm modules as raw static files
     * (e.g. `/prover/` for the layout `scripts/sync-prover` copies into the
     * app's public/). The wasm-bindgen glue and rayon's self-spawn break when
     * they are bundled, so browsers should serve them un-transformed. Default:
     * the sdk's own build output (works when unbundled, e.g. Node or tests).
     */
    proverBaseUrl?: string;
    /**
     * Prove on the calling thread instead of a Web Worker. Defaults to true
     * when there is no `window`/`Worker` (Node, Bun, tests).
     */
    inThread?: boolean;
    /**
     * Max threads for the threaded wasm build. Used only on cross-origin
     * isolated pages; elsewhere the single-threaded build runs. `1` forces
     * single-threaded. Default: all cores.
     */
    threads?: number;
    /** In-thread only: supply the artifacts yourself (they are still hash-checked by the caller). */
    loadArtifacts?: () => Promise<CircuitArtifacts>;
    /** In-thread only: the single-threaded `privacy_cash_prover_bg.wasm` bytes or URL. */
    wasm?: ProverWasmSource;
}
/** Overrides prover settings. Drops any loaded prover so the next call reloads. */
export declare function configureProver(opts: ProverOptions): void;
/** Stops the worker and frees the parsed proving key. */
export declare function terminateProver(): void;
/**
 * Threads the loaded prover uses: more than 1 only with the threaded build on
 * a cross-origin isolated page. `null` until `preloadProver()` or `prove()` has loaded it.
 */
export declare function proverThreads(): number | null;
/**
 * Starts downloading, verifying and parsing the proving artifacts so the
 * first `prove()` does not pay for it. Safe to call repeatedly.
 */
export declare function preloadProver(): Promise<void>;
/** Kept for API compatibility with snarkjs-era callers; the wasm engine loads its own artifacts. */
export declare function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void;
export declare function loadCircuit(): Promise<{
    wasm: Uint8Array;
    zkey: Uint8Array;
}>;
/**
 * Generate a groth16 proof on this device. Same signature and return shape as
 * the snarkjs implementation it replaces — `{proof, publicSignals}` with
 * uncompressed pi_a/pi_b/pi_c — so the downstream proof pipeline is unchanged.
 * Engine: wasm-arkworks in a Web Worker (browser) or on this thread (Node,
 * Bun, tests); multi-threaded when the page is cross-origin isolated.
 */
export declare function prove(input: Record<string, unknown>, _wasm?: Uint8Array, _zkey?: Uint8Array): Promise<{
    proof: Proof;
    publicSignals: string[];
}>;
/** Parse a groth16 proof into the byte layout the Pinocchio Proof struct expects. */
export declare function parseProofToBytesArray(proof: Proof): {
    proofA: number[];
    proofB: number[];
    proofC: number[];
};
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export declare function parseToBytesArray(publicSignals: string[]): number[][];
//# sourceMappingURL=prover.d.ts.map