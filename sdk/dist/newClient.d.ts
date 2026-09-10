import { PublicKey, VersionedTransaction } from "@solana/web3.js";
export interface Signer {
    publicKey: PublicKey;
    signMessage: (message: Uint8Array) => Promise<Uint8Array>;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
}
export declare const SIGN_MESSAGE = "Privacy Money account sign in";
//# sourceMappingURL=newClient.d.ts.map