import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export declare const FIELD_SIZE: BN;
export declare const MERKLE_TREE_DEPTH = 26;
export declare const SOL_MINT: PublicKey;
export declare const WRAPPED_SOL_MINT = "11111111111111111111111111111112";
/** SIWS `Version` field. Stable — not a per-session nonce. */
export declare const SIWS_VERSION = "1";
/**
 * SIWS statement. Must not contain newlines (CAIP / Phantom SIWS).
 * This signature is keccak'd into the shielded spend key.
 */
export declare const SIWS_STATEMENT = "Derive my SilentPay pool keys from this signature. Only approve this on the site your wallet displays.";
/** Fields for Sign In With Solana. Omit nonce / issuedAt so the spend key stays deterministic. */
export type SiwsUnlockInput = {
    domain: string;
    address: string;
    statement?: string;
    uri?: string;
    version?: string;
    chainId?: string;
};
export type SiwsSignInInput = {
    domain: string;
    address: string;
    statement?: string;
    uri?: string;
    version?: string;
    chainId?: string;
};
export type SiwsSignInOutput = {
    signature: Uint8Array;
    signedMessage: Uint8Array;
};
/** Host only (`app.example` or `127.0.0.1:5173`), never a full URL. */
export declare function normalizeSiwsDomain(domain: string): string;
/**
 * Canonical SIWS text (`createSignInMessageText` from the Solana Wallet Standard).
 * Phantom `signIn` constructs the same bytes and checks `domain` against the
 * requesting page — a phishing origin cannot reuse the production message.
 */
export declare function buildUnlockMessage(input: SiwsUnlockInput): string;
export declare function requireStableSiws(signedMessage: Uint8Array, expected: string): void;
export declare function defaultSiwsDomain(): string;
export declare function defaultSiwsUri(): string;
/**
 * Optional SIWS Chain ID (`mainnet` / `devnet` / `localnet`).
 * Do not pass this to Phantom `signIn` unless it matches the wallet's
 * selected network — custom localhost RPCs are usually `mainnet` in Phantom.
 */
export declare function inferSiwsChainId(rpcUrl?: string): string;
export declare const DISC_TRANSACT = 2;
export declare const DISC_TRANSACT_SPL = 3;
export declare const DISC_SWAP = 7;
export declare const DISC_WRAP_SOL = 8;
export declare const SWAP_IX_DISCRIMINATOR: Buffer<ArrayBuffer>;
export declare const WRAP_SOL_IX_DISCRIMINATOR: Buffer<ArrayBuffer>;
export declare const JUPITER_PROGRAM_ID: PublicKey;
export declare const NATIVE_MINT: PublicKey;
export declare const SEED: {
    readonly TREE_ACCOUNT: "merkle_tree";
    readonly TREE_TOKEN: "tree_token";
    readonly GLOBAL_CONFIG: "global_config";
    readonly NULLIFIER0: "nullifier0";
    readonly NULLIFIER1: "nullifier1";
};
export declare const SOL_TREE_KEY = "sol";
export declare function backendUrl(): string;
/**
 * Origin serving `/api/relayer/*`.
 *
 * The relayer is a separate service from the indexer in production — it holds a hot
 * signing key and has its own rate limits and failure modes, so it should not share
 * a process with the thing serving public Merkle data. In dev both are the same shim,
 * so this falls back to the backend URL and needs no configuration.
 */
export declare function relayerUrl(): string;
export declare function envProgramId(): PublicKey | null;
//# sourceMappingURL=constants.d.ts.map