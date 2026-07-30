import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
export type AltSigner = {
    publicKey: PublicKey;
    signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};
export declare function envAltAddress(): PublicKey | null;
export declare function cachedAltAddress(wallet?: PublicKey): PublicKey | null;
export declare function cacheAltAddress(address: PublicKey, wallet?: PublicKey): void;
/** Static + mint-scoped addresses that compress well via an ALT. */
export declare function splAltAddresses(params: {
    programId: PublicKey;
    feeRecipient: PublicKey;
    mint: PublicKey;
}): PublicKey[];
/** Fetch + deserialize an on-chain ALT via the backend (no client RPC). */
export declare function fetchAlt(address: PublicKey): Promise<AddressLookupTableAccount | null>;
/**
 * Ensure an ALT exists that contains the given addresses.
 * Prefers `VITE_ALT_ADDRESS` (read-only — may be owned by the CLI keypair).
 * Falls back to a per-wallet ALT in localStorage, creating/extending as needed.
 */
export declare function ensureAlt(params: {
    signer: AltSigner;
    addresses: PublicKey[];
    preferred?: PublicKey | null;
}): Promise<AddressLookupTableAccount>;
//# sourceMappingURL=alt.d.ts.map