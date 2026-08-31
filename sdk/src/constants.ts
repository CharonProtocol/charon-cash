import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const FIELD_SIZE = new BN(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

export const MERKLE_TREE_DEPTH = 26;

export const SOL_MINT = new PublicKey("11111111111111111111111111111111");
export const WRAPPED_SOL_MINT = "11111111111111111111111111111112";

export const SIGN_MESSAGE = "Privacy Money account sign in";

export const TRANSACT_IX_DISCRIMINATOR = Buffer.from([
  217, 149, 130, 143, 221, 52, 252, 119,
]);

export const TRANSACT_SPL_IX_DISCRIMINATOR = Buffer.from([
  154, 66, 244, 204, 78, 225, 163, 151,
]);

export const PROGRAM_ID = new PublicKey("11111111111111111111111111111112");
export const ALT_ADDRESS = new PublicKey("11111111111111111111111111111112");
export const FEE_RECIPIENT = new PublicKey("11111111111111111111111111111112");

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
  WASM_URL: "/circuit/transaction2.wasm",
  ZKEY_URL: "/circuit/transaction2.zkey",
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
