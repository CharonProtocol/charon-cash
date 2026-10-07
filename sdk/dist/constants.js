import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export const FIELD_SIZE = new BN("21888242871839275222246405745257275088548364400416034343698204186575808495617");
export const MERKLE_TREE_DEPTH = 26;
export const SOL_MINT = new PublicKey("11111111111111111111111111111111");
export const WRAPPED_SOL_MINT = "11111111111111111111111111111112";
export const SIGN_MESSAGE = "Privacy Money account sign in";
export const DISC_TRANSACT = 2;
export const DISC_TRANSACT_SPL = 3;
export const PROGRAM_ID = new PublicKey("A6jNiYjV9g7omJ4zHAyiDQtcRewobsko7gs9UjZ2pWRa");
export const ALT_ADDRESS = new PublicKey("7foo2AGTFZeQaTnmzQ9gqomZ4m4Xv2sreVKNFFu6ZX2o");
export const FEE_RECIPIENT = new PublicKey("5kHwyJA15XjiHYxUTGif8NoH25h1dTxjqhscTnf4V1Ua");
export const SUPPORTED_SPL_MINTS = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
];
export const API_URL = "http://127.0.0.1:8080";
export const SEED = {
    TREE_ACCOUNT: "merkle_tree",
    TREE_TOKEN: "tree_token",
    GLOBAL_CONFIG: "global_config",
    NULLIFIER0: "nullifier0",
    NULLIFIER1: "nullifier1",
};
export const SOL_TREE_KEY = "sol";
export const DEPOSIT_FEE_RATE = 0;
export const WITHDRAW_FEE_RATE = 25;
export const CIRCUIT = {
    WASM_URL: new URL("./circuits/transaction2.wasm", import.meta.url).href,
    ZKEY_URL: new URL("./circuits/transaction2.zkey", import.meta.url).href,
};
function getEnv() {
    try {
        return (import.meta.env ?? {});
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
