import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Utxo } from "./model/utxo";
import BN from "bn.js";
export interface Signer {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}
export declare const SIGN_MESSAGE = "Privacy Money account sign in";
type UtxoRef = {
    utxoId: number;
    walletPubkey: string;
    amount: BN;
};
type UtxoSummary = {
    maxSingleTxAmount: BN;
    totalAmount: BN;
    utxos: UtxoRef[];
};
export declare class CharonProtocol {
    private connection;
    publicKey: PublicKey;
    private encryptionService;
    private signer;
    private storageService;
    private isRuning?;
    private lightwasm;
    private circuit;
    utxoByMint: Map<string, UtxoSummary>;
    lastLoadedNote: number;
    worker: Worker;
    private SYNC_MESSAGE;
    private constructor();
    static generateClient({ rpcUrl, owner, }: {
        rpcUrl: string;
        owner: Signer;
    }): Promise<CharonProtocol>;
    sendSol(amountInLamports: number, recipientKey: string): Promise<{
        signature: void;
    }>;
    withdrawSol(amountInLamports: number): Promise<{
        signature: void;
    }>;
    shieldedTransferSol(amountInLamports: number, recipientKey: string): Promise<{
        signature: string;
    }>;
    sendSpl(amount: number, recipientKey: string, mintAddress: string): Promise<{
        signature: void;
    }>;
    withdrawSpl(amount: number, mintAddress: string): Promise<{
        signature: void;
    }>;
    shieldedTransferSpl(amount: number, recipientKey: string): Promise<{
        signature: string;
    }>;
    syncUtxos(): Promise<void>;
    private recalculateBalances;
    /**
     * @param mintAddress
     * @param amount : For Sol , it has to be in Lamports.
     * @returns
     */
    getRequiredUtxosForAmount(mintAddress: string, amount: BN): Promise<[Utxo[], UtxoRef[]]>;
    stopClient(): Promise<void>;
}
export {};
//# sourceMappingURL=client.d.ts.map