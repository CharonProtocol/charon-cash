export interface Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
}
/** Compressed wire proof (arkworks BE hex, 32/64/32 bytes) as the wasm prover emits. */
export interface CompressedProofWire {
    proof_a: string;
    proof_b: string;
    proof_c: string;
}
export type ProverProof = Proof | CompressedProofWire;
/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export declare function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void;
/**
 * Replacement prover for engine runners (server-side batch payroll): receives
 * the stringified circuit input and returns a proof in the same shape as
 * groth16.fullProve. The browser keeps the default snarkjs wasm prover; a
 * native prover (e.g. rapidsnark) is injected by the payroll engine only.
 */
export type ProverOverride = (input: Record<string, unknown>) => Promise<{
    proof: ProverProof;
    publicSignals: string[];
}>;
export declare function setProver(fn: ProverOverride | null): void;
/**
 * Generate a groth16 proof in-browser. wasm/zkey are fetched once as
 * ArrayBuffers and reused. Mirrors privacy-cash-sdk prove() (single-thread).
 */
export declare function prove(input: Record<string, unknown>): Promise<{
    proof: ProverProof;
    publicSignals: string[];
}>;
/**
 * Parse a groth16 proof into the byte layout the Pinocchio Proof struct
 * expects — 32/64/32 compressed bytes on the wire. Accepts the snarkjs
 * decimal shape (compressed here with arkworks' SWFlags convention) or the
 * wasm prover's already-compressed hex, which passes through untouched.
 */
export declare function parseProofToBytesArray(proof: ProverProof): {
    proofA: number[];
    proofB: number[];
    proofC: number[];
};
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export declare function parseToBytesArray(publicSignals: string[]): number[][];
//# sourceMappingURL=prover.d.ts.map