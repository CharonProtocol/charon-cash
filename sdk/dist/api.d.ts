import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export declare function fetchRecipientViewingKey(pubkey: PublicKey): Promise<Uint8Array<ArrayBuffer>>;
export declare function checkRegistration(pubkey: PublicKey): Promise<any>;
export type RegistrationInfo = {
    wallet_pubkey: PublicKey;
    viewing_pubkey: ViewingKey;
};
type ViewingKey = Uint8Array;
export declare function registerUserInfo(info: RegistrationInfo): Promise<void>;
export type TreeState = {
    nextLeafIndex: BN;
    treeKey: string;
    currentRoot: Uint8Array;
};
export declare function fetchTreeState(mintAddress: string): Promise<TreeState>;
export type MerkleProof = {
    proof: Uint8Array[];
    leaf: Uint8Array;
    index: number;
    root: Uint8Array;
};
export type MerkleProofPair = {
    proof1: MerkleProof;
    proof2: MerkleProof;
};
export declare function fetchMerkleProofForLeaves(mintAddress: string, leafIndex1: string, leafIndex2: string): Promise<MerkleProofPair>;
export type EncryptedNotes = Uint8Array[];
export declare function fetchNotes(lastFetchedNoteIndex: number): Promise<EncryptedNotes>;
export {};
//# sourceMappingURL=api.d.ts.map