import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export declare const FIELD_SIZE: BN;
export declare const MERKLE_TREE_DEPTH = 26;
export declare const SOL_MINT: PublicKey;
export declare const WRAPPED_SOL_MINT = "11111111111111111111111111111112";
export declare const SIGN_MESSAGE = "Privacy Money account sign in";
export declare const DISC_TRANSACT = 2;
export declare const DISC_TRANSACT_SPL = 3;
export declare const PROGRAM_ID: PublicKey;
export declare const ALT_ADDRESS: PublicKey;
export declare const FEE_RECIPIENT: PublicKey;
export declare const SUPPORTED_SPL_MINTS: string[];
export declare const API_URL: string;
export declare const STORAGE_NAMESPACE: string;
export declare const SEED: {
    readonly TREE_ACCOUNT: "merkle_tree";
    readonly TREE_TOKEN: "tree_token";
    readonly GLOBAL_CONFIG: "global_config";
    readonly NULLIFIER0: "nullifier0";
    readonly NULLIFIER1: "nullifier1";
};
export declare const SOL_TREE_KEY = "sol";
export declare const DEPOSIT_FEE_RATE = 0;
export declare const WITHDRAW_FEE_RATE = 25;
export declare function backendUrl(): string;
export declare function envProgramId(): PublicKey | null;
//# sourceMappingURL=constants.d.ts.map