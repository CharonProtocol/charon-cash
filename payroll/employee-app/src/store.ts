import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { NoteLike } from "./lib/rpc";

// Employee app state: settings (persisted) + runtime state (session only).
interface AppState {
  // --- settings (persisted) ---
  backendUrl: string;
  circuitBase: string;
  cluster: "devnet" | "mainnet-beta" | "testnet";
  setSettings: (p: Partial<Pick<AppState, "backendUrl" | "circuitBase" | "cluster">>) => void;

  // --- wallet (persisted so reopening the app does not force a reconnect) ---
  // walletAddress is base58 (display + SDK); walletAddrB64 is the raw base64
  // form MWA requires for signMessages/signTransactions; authToken is the MWA
  // session token used to silently reauthorize on app launch. When the wallet
  // rejects it (expired/revoked) the app falls back to the Connect screen.
  walletAddress: string | null;
  walletAddrB64: string | null;
  authToken: string | null;
  setWallet: (p: {
    walletAddress: string | null;
    walletAddrB64: string | null;
    authToken: string | null;
  }) => void;

  // --- bridge runtime (session) ---
  bridgeReady: boolean;
  webcrypto: boolean;
  hasSdk: boolean;
  setBridgeStatus: (p: { ready: boolean; webcrypto: boolean; hasSdk: boolean }) => void;

  // --- data (session) ---
  // Has this wallet enrolled for private receiving? null = not checked yet
  // (during the initial registry lookup). Written via useApp.setState in the
  // HomeScreen load/enable flows.
  registered: boolean | null;
  // Shielded (note) balance in lamports; what payroll deposits into.
  balanceLamports: number;
  // Wallet's PUBLIC (unshielded) SOL balance in lamports; what a claim adds to.
  publicBalanceLamports: number;
  notes: NoteLike[];
  // Fee schedule from the relayer (for the claim preview). null until fetched.
  feeBps: number | null;
  feeMinLamports: number;
  setBalance: (lamports: number) => void;
  setPublicBalance: (lamports: number) => void;
  setNotes: (n: NoteLike[]) => void;
  setFees: (bps: number | null, minLamports: number) => void;

  // --- ui (session) ---
  busy: boolean;
  busyLabel: string;
  error: string | null;
  toast: string | null;
  setBusy: (b: boolean, label?: string) => void;
  setError: (e: string | null) => void;
  setToast: (t: string | null) => void;
}

const DEFAULTS = {
  // Live devnet stack (same as the main mobile app): Cloudflare Workers relayer
  // + the deployed Vercel frontend (which serves /circuit/*.wasm,zkey). Override
  // in Settings to point at a local payroll chain (surfpool + LAN relayer).
  backendUrl: "https://privacy-cash-relayer.theman-ai-1716.workers.dev",
  circuitBase: "https://privacy-cash-web.vercel.app",
  cluster: "devnet" as const,
};

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setSettings: (p) => set(p),

      walletAddress: null,
      walletAddrB64: null,
      authToken: null,
      setWallet: (p) =>
        set({ walletAddress: p.walletAddress, walletAddrB64: p.walletAddrB64, authToken: p.authToken }),

      bridgeReady: false,
      webcrypto: false,
      hasSdk: false,
      // The bridge posts {ready, webcrypto, hasSdk}; map `ready` onto the
      // `bridgeReady` state field the rest of the app reads. (A plain `set(p)`
      // would write an unused `ready` key and leave `bridgeReady` false forever
      // -> the auto-load effect never fires -> silent balance 0.)
      setBridgeStatus: (p) =>
        set({ bridgeReady: p.ready, webcrypto: p.webcrypto, hasSdk: p.hasSdk }),

      registered: null,
      balanceLamports: 0,
      publicBalanceLamports: 0,
      notes: [],
      feeBps: null,
      feeMinLamports: 0,
      setBalance: (lamports) => set({ balanceLamports: lamports }),
      setPublicBalance: (lamports) => set({ publicBalanceLamports: lamports }),
      setNotes: (n) => set({ notes: n }),
      setFees: (bps, minLamports) => set({ feeBps: bps, feeMinLamports: minLamports }),

      busy: false,
      busyLabel: "",
      error: null,
      toast: null,
      setBusy: (b, label = "") => set({ busy: b, busyLabel: label }),
      setError: (e) => set({ error: e }),
      setToast: (t) => set({ toast: t }),
    }),
    {
      // Fresh key for this app (never share state with the main mobile app).
      name: "privacy-cash-employee-v1",
      storage: createJSONStorage(() => AsyncStorage),
      // persist settings + the MWA wallet session (auth token) so reopening the
      // app silently reauthorizes instead of forcing the Connect screen
      partialize: (s) => ({
        backendUrl: s.backendUrl,
        circuitBase: s.circuitBase,
        cluster: s.cluster,
        walletAddress: s.walletAddress,
        walletAddrB64: s.walletAddrB64,
        authToken: s.authToken,
      }),
    },
  ),
);
