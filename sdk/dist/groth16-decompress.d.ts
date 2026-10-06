type Fp2 = [bigint, bigint];
export declare function decompressG1(hex: string): {
    x: bigint;
    y: bigint;
    inf: boolean;
};
export declare function decompressG2(hex: string): {
    x: Fp2;
    y: Fp2;
    inf: boolean;
};
export interface CompressedProveResponse {
    proof_a: string;
    proof_b: string;
    proof_c: string;
    public_signals: string[];
}
export declare function compressedToSnarkjs({ proof_a, proof_b, proof_c, public_signals }: CompressedProveResponse): {
    proof: import("./prover").Proof;
    publicSignals: string[];
};
export {};
//# sourceMappingURL=groth16-decompress.d.ts.map