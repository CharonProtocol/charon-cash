import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  transact,
  Web3MobileWallet,
} from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useApp } from "../store";
import { CLUSTER } from "../lib/config";
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
  // Several messages in ONE wallet session (one app switch, one approval).
  signMessages: (payloads: Uint8Array[]) => Promise<Uint8Array[]>;
  // Sign a serialized V0 transaction (base64) in the native wallet. Returns the
  // signed transaction, serialized base64. Powers deposits on mobile (deposits
  // can never be gasless - the signer is who puts funds in).
  signTransaction: (txB64: string) => Promise<string>;
}

const Ctx = createContext<WalletCtx | null>(null);

const APP_IDENTITY = {
  name: "Charon",
  uri: "https://charon.cash",
  icon: undefined as string | undefined,
};

const CHAIN = `solana:${CLUSTER}` as const;

const CLEAR_SESSION = {
  walletAddress: null,
  walletAddrB64: null,
  authToken: null,
};

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const setWallet = useApp((s) => s.setWallet);
  // The wallet session lives in the PERSISTED store, so reopening the app
  // starts already connected. Nothing is sent to the wallet on launch (that
  // would open it every time); the saved token rides on the next request.
  const address = useApp((s) => s.walletAddress);
  const authToken = useApp((s) => s.authToken);
  const signAddrB64 = useApp((s) => s.walletAddrB64);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async (): Promise<string | null> => {
    setConnecting(true);
    try {
      const auth = await transact(async (wallet: Web3MobileWallet) => {
        return wallet.authorize({ chain: CHAIN, identity: APP_IDENTITY });
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
  }, [setWallet]);

  const disconnect = useCallback(() => {
    setWallet(CLEAR_SESSION);
  }, [setWallet]);

  // One wallet session: re-authorize with the saved token, then run `fn`. A
  // token the wallet no longer honors drops the session (back to Connect).
  const withWallet = useCallback(
    async <T,>(fn: (wallet: Web3MobileWallet) => Promise<T>): Promise<T> => {
      if (!address || !authToken || !signAddrB64) throw new Error("Wallet not connected");
      return transact(async (wallet: Web3MobileWallet) => {
        let auth;
        try {
          auth = await wallet.authorize({ chain: CHAIN, identity: APP_IDENTITY, auth_token: authToken });
        } catch (e) {
          setWallet(CLEAR_SESSION);
          throw e;
        }
        if (auth.auth_token !== authToken) {
          setWallet({ walletAddress: address, walletAddrB64: signAddrB64, authToken: auth.auth_token });
        }
        return fn(wallet);
      });
    },
    [address, authToken, signAddrB64, setWallet],
  );

  const signMessages = useCallback(
    (payloads: Uint8Array[]): Promise<Uint8Array[]> =>
      // signMessages requires the BASE64 address form.
      withWallet((wallet) => wallet.signMessages({ addresses: [signAddrB64 as string], payloads })),
    [withWallet, signAddrB64],
  );

  const signMessage = useCallback(
    async (bytes: Uint8Array): Promise<Uint8Array> => (await signMessages([bytes]))[0],
    [signMessages],
  );

  const signTransaction = useCallback(
    async (txB64: string): Promise<string> => {
      // Rehydrate the unsigned V0 tx the SDK built, hand it to the native wallet
      // (which fills the signer's signature), then re-serialize for the SDK.
      const unsigned = VersionedTransaction.deserialize(b64ToBytes(txB64));
      const signed = await withWallet(async (wallet) => {
        const out = await wallet.signTransactions({ transactions: [unsigned] });
        return out[0] as VersionedTransaction;
      });
      return bytesToB64(signed.serialize());
    },
    [withWallet],
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
      signMessages,
      signTransaction,
    }),
    [address, authToken, connecting, connect, disconnect, signMessage, signMessages, signTransaction],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
