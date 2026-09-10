import { PublicKey, TransactionInstruction } from "@solana/web3.js";
/** SIMD-0385 v1 version prefix. */
export declare const V1_PREFIX = 129;
export declare const V1_MAX_SIZE = 4096;
export declare const V1_MAX_ACCOUNTS = 64;
export interface CompileV1Params {
    feePayer: PublicKey;
    blockhash: string;
    instructions: TransactionInstruction[];
    /** Defaults to 1_400_000. v1 has no ComputeBudget instructions. */
    computeUnitLimit?: number;
    /** Defaults to 64 MiB. Must be set or the runtime rejects the tx. */
    loadedAccountsDataSizeLimit?: number;
}
/** Compile an unsigned v1 transaction (signatures are appended by `signWireTransaction`). */
export declare function compileV1Transaction(params: CompileV1Params): Uint8Array;
/** Ed25519-sign a v1 message. Signatures are appended (SIMD-0385). */
export declare function signWireTransaction(message: Uint8Array, secretKeys: Uint8Array[]): Uint8Array;
export declare function v1SignedSize(message: Uint8Array): number;
//# sourceMappingURL=tx-v1.d.ts.map