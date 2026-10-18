import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SOL, type Asset } from "./lib/assets";
import type { Balances } from "./lib/rpc";

// Wallet session (persisted) + runtime state (session only).
interface AppState {
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

  // --- account (session) ---
  /** Unlocked + enrolled for private receiving. */
  unlocked: boolean;
  assets: Asset[];
  feeBps: number;
  balances: Balances;
  /** Wallet (public) balances in raw units, keyed like `balances`. */
  walletBalances: Record<string, string>;
  setAccount: (p: { assets: Asset[]; feeBps: number }) => void;
  setBalances: (b: Balances) => void;
  setWalletBalances: (b: Record<string, string>) => void;

  // --- ui (session) ---
  busy: boolean;
  busyLabel: string;
  error: string | null;
  toast: string | null;
  setBusy: (b: boolean, label?: string) => void;
  setError: (e: string | null) => void;
  setToast: (t: string | null) => void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      walletAddress: null,
      walletAddrB64: null,
      authToken: null,
      setWallet: (p) =>
        set({ walletAddress: p.walletAddress, walletAddrB64: p.walletAddrB64, authToken: p.authToken }),

      bridgeReady: false,
      webcrypto: false,
      hasSdk: false,
      // The bridge posts {ready, webcrypto, hasSdk}; map `ready` onto the
      // `bridgeReady` state field the rest of the app reads.
      setBridgeStatus: (p) =>
        set({ bridgeReady: p.ready, webcrypto: p.webcrypto, hasSdk: p.hasSdk }),

      unlocked: false,
      assets: [SOL],
      feeBps: 25,
      balances: {},
      walletBalances: {},
      setAccount: (p) => set({ unlocked: true, assets: p.assets, feeBps: p.feeBps }),
      setBalances: (b) => set({ balances: b }),
      setWalletBalances: (b) => set({ walletBalances: b }),

      busy: false,
      busyLabel: "",
      error: null,
      toast: null,
      setBusy: (b, label = "") => set({ busy: b, busyLabel: label }),
      setError: (e) => set({ error: e }),
      setToast: (t) => set({ toast: t }),
    }),
    {
      // v5: Settings (backend/circuit/cluster) are gone; the network is fixed.
      name: "charon-mobile-v5",
      storage: createJSONStorage(() => AsyncStorage),
      // only the MWA wallet session survives a restart
      partialize: (s) => ({
        walletAddress: s.walletAddress,
        walletAddrB64: s.walletAddrB64,
        authToken: s.authToken,
      }),
    },
  ),
);
