import BN from "bn.js";
import { SilentPayError } from "./error";
export declare class ProofGenError extends SilentPayError {
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
/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export declare function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void;
export declare function loadCircuit(): Promise<{
    wasm: Uint8Array;
    zkey: Uint8Array;
}>;
/**
 * Generate a groth16 proof in-browser. wasm/zkey are fetched once as
 * ArrayBuffers and reused. Mirrors privacy-cash-sdk prove() (single-thread).
 */
export declare function prove(input: Record<string, unknown>, wasm: Uint8Array, zkey: Uint8Array): Promise<{
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