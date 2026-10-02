import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  transact,
  Web3MobileWallet,
} from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useApp } from "../store";
import { b64ToBytes, bytesToB64 } from "../lib/bytes";

// MWA returns authorized account addresses BASE64-ENCODED (see
// Account.address: Base64EncodedAddress in mobile-wallet-adapter-protocol).
// The rest of the app (display + the SDK's walletPubkey) needs a normal base58
// Solana address, so decode base64 -> 32 bytes -> base58. NOTE: signMessages()
// and signTransactions() still take the raw base64 address, so we keep both.
function decodeMwaAddress(raw: string): string | null {
  try {
    const bytes = b64ToBytes(raw);
    if (bytes.length !== 32) return null;
    return new PublicKey(bytes).toBase58();
  } catch {
    return null;
  }
}

interface WalletCtx {
  address: string | null;
  authToken: string | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<string | null>;
  disconnect: () => void;
  signMessage: (bytes: Uint8Array) => Promise<Uint8Array>;
  // Sign a serialized V0 transaction (base64) in the native wallet. Returns the
  // signed transaction, serialized base64. Powers depositSOL/depositSPL on mobile
  // (deposits can never be gasless - the signer is who puts funds in).
  signTransaction: (txB64: string) => Promise<string>;
}

const Ctx = createContext<WalletCtx | null>(null);

const APP_IDENTITY = {
  name: "Charon Pay",
  uri: "https://privacycash.dev",
  icon: undefined as string | undefined,
};

const CLEAR_SESSION = {
  walletAddress: null,
  walletAddrB64: null,
  authToken: null,
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const cluster = useApp((s) => s.cluster);
  const setWallet = useApp((s) => s.setWallet);
  // The wallet session lives in the PERSISTED store, so reopening the app
  // starts already connected instead of dropping to the Connect screen.
  const address = useApp((s) => s.walletAddress);
  const authToken = useApp((s) => s.authToken);
  const signAddrB64 = useApp((s) => s.walletAddrB64);
  const [connecting, setConnecting] = useState(false);

  // On launch, silently reauthorize the persisted MWA session. If the wallet
  // still honors the token this refreshes it with zero user interaction; if it
  // expired/was revoked the call rejects and we clear the session so the app
  // falls back to the normal Connect flow.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    const token = useApp.getState().authToken;
    if (!token) return;
    (async () => {
      try {
        const auth = await transact(async (wallet: Web3MobileWallet) => {
          return wallet.reauthorize({ auth_token: token, identity: APP_IDENTITY });
        });
        if (auth?.auth_token) {
          setWallet({
            walletAddress: useApp.getState().walletAddress,
            walletAddrB64: useApp.getState().walletAddrB64,
            authToken: auth.auth_token,
          });
        }
      } catch {
        setWallet(CLEAR_SESSION);
      }
    })();
  }, [setWallet]);

  const connect = useCallback(async (): Promise<string | null> => {
    setConnecting(true);
    try {
      const auth = await transact(async (wallet: Web3MobileWallet) => {
        return wallet.authorize({
          cluster,
          identity: APP_IDENTITY,
        });
      });
      // MWA returns the account address base64-encoded. Decode to base58 for the
      // app/SDK; keep the raw base64 for signMessages()/signTransactions().
      const raw = auth.accounts[0]?.address ?? null;
      const addr = raw ? decodeMwaAddress(raw) : null;
      if (addr && raw) {
        setWallet({ walletAddress: addr, walletAddrB64: raw, authToken: auth.auth_token });
      }
      return addr;
    } finally {
      setConnecting(false);
    }
  }, [cluster, setWallet]);

  const disconnect = useCallback(() => {
    setWallet(CLEAR_SESSION);
  }, [setWallet]);

  const signMessage = useCallback(
    async (bytes: Uint8Array): Promise<Uint8Array> => {
      const b64 = signAddrB64;
      if (!address || !authToken || !b64) {
        throw new Error("Wallet not connected");
      }
      const sigs = await transact(async (wallet: Web3MobileWallet) => {
        await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
        return wallet.signMessages({
          // signMessages requires the BASE64 address form.
          addresses: [b64],
          payloads: [bytes],
        });
      });
      return sigs[0];
    },
    [address, authToken, signAddrB64],
  );

  const signTransaction = useCallback(
    async (txB64: string): Promise<string> => {
      if (!authToken || !signAddrB64) {
        throw new Error("Wallet not connected");
      }
      // Rehydrate the unsigned V0 tx the SDK built, hand it to the native wallet
      // (which fills the signer's signature), then re-serialize for the SDK.
      const unsigned = VersionedTransaction.deserialize(b64ToBytes(txB64));
      const signed = await transact(async (wallet: Web3MobileWallet) => {
        await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
        const out = await wallet.signTransactions({ transactions: [unsigned] });
        return out[0] as VersionedTransaction;
      });
      return bytesToB64(signed.serialize());
    },
    [authToken, signAddrB64],
  );

  const value = useMemo<WalletCtx>(
    () => ({
      address,
      authToken,
      connected: !!address,
      connecting,
      connect,
      disconnect,
      signMessage,
      signTransaction,
    }),
    [address, authToken, connecting, connect, disconnect, signMessage, signTransaction],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
