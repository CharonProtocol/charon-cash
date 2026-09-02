import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { MerkleProofPair } from "./api";
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
export declare function deriveAccounts(programId: PublicKey, nullifierHash0: Uint8Array, nullifierHash1: Uint8Array): TransactAccounts;
export declare function serializeProofAndExtData(proof: ProofBytes, extData: ExtData, isSpl?: boolean): Buffer<ArrayBuffer>;
export declare function buildMerkleCircuitInputs(pair: MerkleProofPair): {
    inPathElements: string[][];
    inPathIndices: number[];
    root: string;
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
export declare function getExtDataHash(ext: {
    recipient: PublicKey | string;
    extAmount: BN | number | string;
    encryptedOutput1: Uint8Array;
    encryptedOutput2: Uint8Array;
    fee: BN | number | string;
    feeRecipient: PublicKey | string;
    mintAddress: PublicKey | string;
}): Uint8Array;
//# sourceMappingURL=utils.d.ts.map