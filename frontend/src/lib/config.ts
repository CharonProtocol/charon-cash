import { PublicKey } from "@solana/web3.js";

export type Token = "SOL" | "USDC" | "USDT" | "TEST";
export const IS_DEVNET = import.meta.env.VITE_SOLANA_CLUSTER === "devnet";
export const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || "http://127.0.0.1:8899";
export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ?? "").replace(/\/$/, "");
export const PROGRAM_ID = import.meta.env.VITE_PROGRAM_ID as string | undefined;
export const FEE_RECIPIENT = import.meta.env.VITE_FEE_RECIPIENT as string | undefined;
export const SOL_POOL_MINT = "11111111111111111111111111111112";

const testMint = import.meta.env.VITE_SUPPORTED_SPL_MINTS?.split(",")[0]?.trim();
if (IS_DEVNET && !testMint) {
  throw new Error("Devnet requires VITE_SUPPORTED_SPL_MINTS with the deployed test mint.");
}

export const SPL_MINTS: Partial<Record<Token, string>> = IS_DEVNET
  ? { TEST: testMint }
  : {
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    };
export const AVAILABLE_TOKENS: Token[] = IS_DEVNET
  ? ["SOL", "TEST"]
  : ["SOL", "USDC", "USDT"];

export function mintForToken(token: Token): string {
  const mint = token === "SOL" ? SOL_POOL_MINT : SPL_MINTS[token];
  if (!mint) throw new Error(`${token} is unavailable on this network.`);
  return new PublicKey(mint).toBase58();
}

export function transactionExplorerUrl(signature: string): string {
  const query = IS_DEVNET
    ? new URLSearchParams({ cluster: "devnet" })
    : new URLSearchParams({ cluster: "custom", customUrl: RPC_URL });
  return `https://explorer.solana.com/tx/${signature}?${query}`;
}
