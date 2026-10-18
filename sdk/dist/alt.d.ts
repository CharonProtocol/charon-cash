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
/** A shared (read-only) table, when it holds every address in `common`. */
export declare function sharedAlt(address: PublicKey, common: PublicKey[]): Promise<AddressLookupTableAccount | null>;
/**
 * Ensure an ALT exists that contains the given addresses.
 * Prefers a shared table — the relayer's per-mint table (`shared`), then
 * `VITE_ALT_ADDRESS` — when it holds every `common` address (default: all of
 * `addresses`); the wallet's own addresses then stay inline, which still fits
 * v0. Falls back to a per-wallet ALT in localStorage, creating/extending as
 * needed.
 */
export declare function ensureAlt(params: {
    signer: AltSigner;
    addresses: PublicKey[];
    preferred?: PublicKey | null;
    shared?: PublicKey | null;
    common?: PublicKey[];
}): Promise<AddressLookupTableAccount>;
//# sourceMappingURL=alt.d.ts.map