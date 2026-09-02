import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
export interface Signer {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}
export declare const SIGN_MESSAGE = "Privacy Money account sign in";
type SanitizedNote = {
    note_id: number;
    walletPubkey: string;
    amount: BN;
};
type NotesInfo = {
    maxAmountInSingleTransaction: BN;
    totalAmount: BN;
    notes: SanitizedNote[];
};
export declare class SilentPay {
    private connection;
    publicKey: PublicKey;
    private encryptionService;
    private signer;
    private storageService;
    private isRuning?;
    private lightwasm;
    mintToNotesMap: Map<string, NotesInfo>;
    lastLoadedNote: number;
    worker: Worker;
    private constructor();
    static generateClient({ RPC_url, owner, }: {
        RPC_url: string;
        owner: Signer;
        API_URL: string;
    }): Promise<SilentPay>;
    sendSol(amountInLamports: number, mintAddress: string, recipientKey: string): Promise<void>;
    withdrawSol(amountInLamports: number, mintAddress: string): Promise<void>;
    syncNotes(): Promise<void>;
}
export {};
//# sourceMappingURL=newClient.d.ts.map