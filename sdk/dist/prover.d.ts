import { type CircuitArtifacts } from "./circuit-artifacts";
import { type ProverWasmSource } from "./prover-core";
import BN from "bn.js";
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
export interface Groth16Proof {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    publicSignals: string[];
}
export interface ProverOptions {
    /** Where `transaction2.zkey` and `transaction2.graph` are served. Default `/circuit/`. */
    circuitBaseUrl?: string;
    /**
     * Prove on the calling thread instead of a Web Worker. Defaults to true
     * when there is no `window`/`Worker` (Node, Bun, tests).
     */
    inThread?: boolean;
    /**
     * Max threads for the threaded wasm build. It is used only on cross-origin
     * isolated pages (COOP `same-origin` + COEP `require-corp`); elsewhere the
     * single-threaded build runs. `1` forces single-threaded. Default: all cores.
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
/**
 * Generates a Groth16 proof on this device (Web Worker in browsers).
 * Returns compressed 32/64/32 bytes and the 7 public signals. The witness,
 * including the spend key, is never sent over the network.
 */
export declare function prove(input: Record<string, unknown>): Promise<Groth16Proof>;
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export declare function parseToBytesArray(publicSignals: string[]): number[][];
//# sourceMappingURL=prover.d.ts.map