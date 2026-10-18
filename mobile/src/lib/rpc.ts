// Types for the RN <-> WebView bridge RPC. Mirrors bridge/bridge-host.js.

export type BridgeMethod =
  | "status"
  | "diag"
  | "start"
  | "refresh"
  | "getNotes"
  | "balances"
  | "isRegistered"
  | "deposit"
  | "depositTo"
  | "withdraw"
  | "transferPrivate"
  | "swap"
  | "exportNotes"
  | "importNotes";

// RN -> bridge
export interface CallMsg {
  id: number;
  type: "call";
  method: BridgeMethod;
  args: unknown[];
}
export interface SignResponseMsg {
  signId: number;
  type: "signResponse";
  signatureB64?: string;
  error?: string;
}

// RN -> bridge: the wallet's signed V0 transaction (base64 serialized), or an
// error if the wallet declined the signTransaction prompt.
export interface SignTxResponseMsg {
  signId: number;
  type: "signTxResponse";
  signedTxB64?: string;
  error?: string;
}

// RN -> bridge: one wallet session's signatures (base64), in request order.
export interface SignBatchResponseMsg {
  signId: number;
  type: "signBatchResponse";
  signaturesB64?: string[];
  error?: string;
}

// RN -> bridge: the native prover's `{proof_a, proof_b, proof_c, public_signals}` JSON.
export interface ProveResponseMsg {
  proveId: number;
  type: "proveResponse";
  rawJson?: string;
  error?: string;
}

// bridge -> RN
export type BridgeInbound =
  | { type: "ready"; webcrypto: boolean; hasSdk: boolean }
  | { id: number; type: "result"; ok: true; data: unknown }
  | { id: number; type: "result"; ok: false; error: string; stack?: string }
  | { type: "signRequest"; signId: number; messageB64: string }
  | { type: "signTxRequest"; signId: number; txB64: string }
  | { type: "signBatchRequest"; signId: number; messagesB64: string[] }
  | { type: "proveRequest"; proveId: number; inputJson: string };

export interface BridgeConfig {
  walletPubkey: string;
  backendUrl: string;
  circuitBase: string;
  nativeProver: boolean;
}

// Result shapes (from the SDK, JSON-ified in the bridge)
export interface StartResult {
  pubkey: string;
  feeBps: number;
  mints: { mint: string; symbol: string | null; decimals: number | null }[];
}
export interface AssetBalance {
  /** Raw units, decimal string. */
  total: string;
  /** Largest amount one spend can move (two notes). */
  maxSingle: string;
  noteCount: number;
}
/** Keyed by "SOL" or token mint. */
export type Balances = Record<string, AssetBalance>;
export interface RefreshResult {
  scanned?: number;
  added?: number;
  spent?: number;
}
export interface DiagResult {
  backendUrl: string;
  reachable: boolean;
  fetchError: string | null;
}
export interface TxResult {
  signature: string;
}
export interface NoteLike {
  id: string;
  amount: string;
  mintAddress: string;
  index: number;
  spent: boolean;
}
