import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export const FIELD_SIZE = new BN("21888242871839275222246405745257275088548364400416034343698204186575808495617");
export const MERKLE_TREE_DEPTH = 26;
export const SOL_MINT = new PublicKey("11111111111111111111111111111111");
export const WRAPPED_SOL_MINT = "11111111111111111111111111111112";
export const SIGN_MESSAGE = "Privacy Money account sign in";
export const RECEIVE_SIGN_MESSAGE = "Privacy Money receive key v2";
// transact / transact_spl take raw (uncompressed) Groth16 points; only swap
// (7) carries compressed ones.
export const DISC_TRANSACT = 2;
export const DISC_TRANSACT_SPL = 3;
export const SEED = {
    TREE_ACCOUNT: "merkle_tree",
    TREE_TOKEN: "tree_token",
    GLOBAL_CONFIG: "global_config",
    /** One spent marker per nullifier, whichever input slot spends it. */
    NULLIFIER: "nullifier",
};
export const SOL_TREE_KEY = "sol";
export const CIRCUIT = {
    WASM_URL: "/circuit/transaction2.wasm",
    ZKEY_URL: "/circuit/transaction2.zkey",
};
function getEnv() {
    try {
        return import.meta.env ?? {};
    }
    catch {
        return {};
    }
}
export function backendUrl() {
    const env = getEnv();
    return (env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");
}
export function envProgramId() {
    const env = getEnv();
    const v = env.VITE_PROGRAM_ID;
    try {
        return v ? new PublicKey(v) : null;
    }
    catch {
        return null;
    }
}
