export interface HostedProof {
    proofA: number[];
    proofB: number[];
    proofC: number[];
    publicSignals: string[];
}
/**
 * Generate a groth16 proof via POST /api/prove (ark-groth16).
 * Returns compressed 32/64/32 bytes. Does not log the witness.
 */
export declare function prove(input: Record<string, unknown>): Promise<HostedProof>;
/** Parse public signals into 32-byte big-endian field-element byte arrays. */
export declare function parseToBytesArray(publicSignals: string[]): number[][];
//# sourceMappingURL=prover.d.ts.map