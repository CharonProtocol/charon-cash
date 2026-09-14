import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const FIELD_SIZE = new BN(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export const MERKLE_TREE_DEPTH = 26;

export const SOL_MINT = new PublicKey("11111111111111111111111111111111");
export const WRAPPED_SOL_MINT = "11111111111111111111111111111112";

export const SIGN_MESSAGE = "Privacy Money account sign in";

export const DISC_TRANSACT = 2;
export const DISC_TRANSACT_SPL = 3;

export const PROGRAM_ID = new PublicKey(
  "6MyU66azgzrp6eioGxmKrGZSxv7FB9nb1oXSrd1Qkwmn",
);
export const ALT_ADDRESS = new PublicKey(
  "DZc7vA8pBXbjPeKTsGsmhMzGMEfk8aYn4YCCXzHp9c9V",
);
export const FEE_RECIPIENT = new PublicKey(
  "5kHwyJA15XjiHYxUTGif8NoH25h1dTxjqhscTnf4V1Ua",
);

export const API_URL = "http://127.0.0.1:8080";

export const SEED = {
  TREE_ACCOUNT: "merkle_tree",
  TREE_TOKEN: "tree_token",
  GLOBAL_CONFIG: "global_config",
  NULLIFIER0: "nullifier0",
  NULLIFIER1: "nullifier1",
} as const;

export const SOL_TREE_KEY = "sol";

export const DEPOSIT_FEE_RATE = 0;
export const WITHDRAW_FEE_RATE = 25;

export const CIRCUIT = {
  WASM_URL: new URL("./circuits/transaction2.wasm", import.meta.url).href,

  ZKEY_URL: new URL("./circuits/transaction2.zkey", import.meta.url).href,
};

function getEnv(): Record<string, string | undefined> {
  try {
    return (
      (import.meta as unknown as { env?: Record<string, string> }).env ?? {}
    );
  } catch {
    return {};
  }
}

export function backendUrl(): string {
  const env = getEnv();
  return (env.VITE_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

export function envProgramId(): PublicKey | null {
  const env = getEnv();
  const v = env.VITE_PROGRAM_ID;
  try {
    return v ? new PublicKey(v) : null;
  } catch {
    return null;
  }
}
