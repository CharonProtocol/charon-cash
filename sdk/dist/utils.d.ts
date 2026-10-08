import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { ProofBytes } from "./prover";
export declare function bytesToBN(bytes: Uint8Array): BN;
export declare function getMintAddressField(mint: PublicKey): string;
export type ExtData = {
    recipient: PublicKey | string;
    extAmount: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    fee: BN | number | string;
    feeRecipient: PublicKey | string;
    mintAddress: PublicKey | string;
};
export interface TransactAccounts {
    treeAccount: PublicKey;
    treeTokenAccount: PublicKey;
    globalConfig: PublicKey;
    nullifier0: PublicKey;
    nullifier1: PublicKey;
    nullifier2: PublicKey;
    nullifier3: PublicKey;
    bump0: number;
    bump1: number;
}
export declare function deriveAccounts(programId: PublicKey, nullifierHash0: Uint8Array, nullifierHash1: Uint8Array, mintAddress?: PublicKey): TransactAccounts;
export declare function deriveNullifiers(nullifierHash: Uint8Array): PublicKey[] | undefined;
export declare function poseidonStringToBytes32(hashStr: string): Uint8Array;
export declare function serializeProofAndExtData(proof: ProofBytes, extData: ExtData, isSpl: boolean | undefined, bump0: number, bump1: number): Buffer<ArrayBuffer>;
export declare function getExtDataHash(ext: {
    recipient: PublicKey | string;
    extAmount: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    fee: BN | number | string;
    feeRecipient: PublicKey | string;
    mintAddress: PublicKey | string;
}): Uint8Array;
/** In-leg hash. Byte layout matches `calculate_swap_in_ext_data_hash`. */
export declare function getSwapInExtDataHash(args: {
    extAmountIn: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    inMint: PublicKey | string;
    outMint: PublicKey | string;
    minAmountOut: BN | number | string;
    outCommitments: [Uint8Array, Uint8Array];
}): Uint8Array;
/** Out-leg hash. Does not mention the in-leg. Matches `calculate_swap_out_ext_data_hash`. */
export declare function getSwapOutExtDataHash(args: {
    extAmountOut: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    outMint: PublicKey | string;
}): Uint8Array;
//# sourceMappingURL=utils.d.ts.map