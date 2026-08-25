export interface Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
}
/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export declare function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void;
/**
 * Replacement prover for engine runners (server-side batch payroll): receives
 * the stringified circuit input and returns a proof in the same shape as
 * groth16.fullProve. The browser keeps the default snarkjs wasm prover; a
 * native prover (e.g. rapidsnark) is injected by the payroll engine only.
 */
export type ProverOverride = (input: Record<string, unknown>) => Promise<{
    proof: Proof;
    publicSignals: string[];
}>;
export declare function setProver(fn: ProverOverride | null): void;
/**
 * Generate a groth16 proof in-browser. wasm/zkey are fetched once as
 * ArrayBuffers and reused. Mirrors privacy-cash-sdk prove() (single-thread).
 */
export declare function prove(input: Record<string, unknown>): Promise<{
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