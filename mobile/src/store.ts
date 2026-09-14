import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { NoteLike } from "./lib/rpc";

// Settings (persisted) + runtime state (session only).
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
  balanceLamports: number;
  // Wallet's PUBLIC (unshielded) SOL balance, in lamports. Read straight from the
  // RPC so the user sees how much they can deposit-and-send (deposits debit this).
  publicBalanceLamports: number;
  notes: NoteLike[];
  setBalance: (lamports: number) => void;
  setPublicBalance: (lamports: number) => void;
  setNotes: (n: NoteLike[]) => void;

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
  // Live devnet stack: Cloudflare quick-tunnel in front of the VM relayer, and
  // the deployed Vercel frontend (which serves /circuit/*.wasm,zkey). Override
  // in Settings to point at your own relayer / circuit host. NOTE: the quick-
  // tunnel subdomain is ephemeral -- if the app shows "Backend unreachable",
  // the tunnel rotated; update this in Settings to the current tunnel URL.
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
      // `bridgeReady` state field the rest of the app reads. (Previously this
      // did `set(p)`, which wrote an unused `ready` key and left `bridgeReady`
      // false forever -> the auto-load effect never fired -> silent balance 0.)
      setBridgeStatus: (p) =>
        set({ bridgeReady: p.ready, webcrypto: p.webcrypto, hasSdk: p.hasSdk }),

      balanceLamports: 0,
      publicBalanceLamports: 0,
      notes: [],
      setBalance: (lamports) => set({ balanceLamports: lamports }),
      setPublicBalance: (lamports) => set({ publicBalanceLamports: lamports }),
      setNotes: (n) => set({ notes: n }),

      busy: false,
      busyLabel: "",
      error: null,
      toast: null,
      setBusy: (b, label = "") => set({ busy: b, busyLabel: label }),
      setError: (e) => set({ error: e }),
      setToast: (t) => set({ toast: t }),
    }),
    {
      // Bumped from "privacy-cash-mobile-v3" so a fresh install / upgrade drops
      // the stale persisted backendUrl (the old quick-tunnel URL is dead now
      // that the backend lives on Cloudflare Workers).
      // Only settings are persisted, so a flush is safe.
      name: "privacy-cash-mobile-v4",
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
