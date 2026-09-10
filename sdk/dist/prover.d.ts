export interface Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
}
export interface HostedProof {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    publicSignals: string[];
}
/** Inject pre-loaded circuit buffers (used by tests / non-browser runners). */
export declare function setCircuitBuffers(wasm: Uint8Array, zkey: Uint8Array): void;
/**
 * Generate a groth16 proof via POST /api/prove (ark-groth16).
 * Returns compressed 32/64/32 bytes. Does not log the witness.
 */
export declare function prove(input: Record<string, unknown>): Promise<{
    proof: Proof;
    publicSignals: string[];
    proofA: number[];
    proofB: number[];
    proofC: number[];
}>;
/** In-process snarkjs prove (tests / leftover path). */
export declare function proveSnarkjs(input: Record<string, unknown>): Promise<{
    proof: Proof;
    publicSignals: string[];
}>;
/** Parse a groth16 proof into the compressed byte layout the Pinocchio Proof struct expects. */
export declare function parseProofToBytesArray(proof: Proof): {
    proofA: number[];
    proofB: number[];
    proofC: number[];
};
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export declare function parseToBytesArray(publicSignals: string[]): number[][];
//# sourceMappingURL=prover.d.ts.map