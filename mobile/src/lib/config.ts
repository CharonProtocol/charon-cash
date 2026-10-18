// Fixed network config: devnet, our backend. No Settings screen.
export const BACKEND_URL = "https://backend.charon.cash";
// Serves /circuit/transaction2.{wasm,zkey} for the in-WebView fallback prover
// (only used when the app was built without the native prover).
export const CIRCUIT_BASE = "https://betapay.charon.cash";
export const CLUSTER = "devnet" as const;
// Swap routes through Jupiter, which has no devnet liquidity.
export const SWAP_AVAILABLE = false;
export const EXPLORER_TX = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
