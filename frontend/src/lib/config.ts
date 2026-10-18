export const RPC_URL = import.meta.env.VITE_SOLANA_RPC_URL || 'http://127.0.0.1:8899';
// Charon backend (relayer + indexer); local default matches ./run.sh.
// Private swap routes through Jupiter, which only has mainnet liquidity:
// builds turn it on with VITE_SWAP_ENABLED=1 (mainnet); devnet shows a notice.
export const SWAP_AVAILABLE = import.meta.env.VITE_SWAP_ENABLED === '1';
export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:8080';
