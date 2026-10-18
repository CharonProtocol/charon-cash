import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export declare const FIELD_SIZE: BN;
export declare const MERKLE_TREE_DEPTH = 26;
export declare const SOL_MINT: PublicKey;
export declare const WRAPPED_SOL_MINT = "11111111111111111111111111111112";
export declare const SIGN_MESSAGE = "Privacy Money account sign in";
export declare const RECEIVE_SIGN_MESSAGE = "Privacy Money receive key v2";
export declare const DISC_TRANSACT = 2;
export declare const DISC_TRANSACT_SPL = 3;
export declare const SEED: {
    readonly TREE_ACCOUNT: "merkle_tree";
    readonly TREE_TOKEN: "tree_token";
    readonly GLOBAL_CONFIG: "global_config";
    /** One spent marker per nullifier, whichever input slot spends it. */
    readonly NULLIFIER: "nullifier";
};
export declare const SOL_TREE_KEY = "sol";
export declare const CIRCUIT: {
    WASM_URL: string;
    ZKEY_URL: string;
};
export declare function backendUrl(): string;
export declare function envProgramId(): PublicKey | null;
//# sourceMappingURL=constants.d.ts.map