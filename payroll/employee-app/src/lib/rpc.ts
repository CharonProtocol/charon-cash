// Types for the RN <-> WebView bridge RPC. Mirrors bridge/bridge-host.js.

export type BridgeMethod =
  | "status"
  | "diag"
  | "unlock"
  | "refresh"
  | "getNotes"
  | "balance"
  | "registered"
  | "enableReceiving"
  | "relayerInfo"
  | "withdraw";

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

// bridge -> RN
export type BridgeInbound =
  | { type: "ready"; webcrypto: boolean; hasSdk: boolean }
  | { id: number; type: "result"; ok: true; data: unknown }
  | { id: number; type: "result"; ok: false; error: string; stack?: string }
  | { type: "signRequest"; signId: number; messageB64: string }
  | { type: "signTxRequest"; signId: number; txB64: string };

export interface BridgeConfig {
  walletPubkey: string;
  backendUrl: string;
  circuitBase: string;
}

// Result shapes (from the SDK, JSON-ified in the bridge)
export interface BalanceResult {
  lamports: number;
  sol: number;
  noteCount: number;
}
export interface RefreshResult {
  scanned: number;
  added: number;
  spent: number;
}
export interface DiagResult {
  backendUrl: string;
  reachable: boolean;
  treeNextLeaf: number | null;
  fetchError: string | null;
}
// registered: has this wallet published its private receiving keys?
export interface RegisteredResult {
  registered: boolean;
}
export interface EnableReceivingResult {
  registered: true;
}
// relayerInfo: fee schedule for the claim (withdraw) preview.
export interface RelayerInfoResult {
  bps: number;
  minFee: number;
}
export interface WithdrawResult {
  signature: string;
  recipientLamports: number;
  feeLamports: number;
  changeLamports: string;
  nullifiers?: string[];
}
export interface NoteLike {
  id: string;
  amount: string;
  mintAddress: string;
  index: number;
  spent: boolean;
  createdAt?: number;
  depositTx?: string;
  spendTx?: string;
}
