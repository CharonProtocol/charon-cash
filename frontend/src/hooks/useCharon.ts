import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { CharonProtocol } from "charonprotocol-sdk";
import { RPC_URL } from "../lib/config";
import { SOL_POOL_MINT } from "../lib/payment";
import { sessionSignMessage } from "../lib/sessionSeed";
import type { TransactionStage } from "../components/dashboard/types";

export function useCharon(enabled: boolean) {
  const { publicKey, signMessage, signTransaction, disconnect } = useWallet();
  const address = publicKey?.toBase58();

  // reference to currentCharon Client
  const current = useRef<CharonProtocol | null>(null);
  const generation = useRef(0);

  const progress = useRef<((stage: TransactionStage) => void) | null>(null);
  const observeProgress = (
    listener: ((stage: TransactionStage) => void) | null,
  ) => {
    progress.current = listener;
  };

  const initializing = useRef(false);

  const [client, setClient] = useState<CharonProtocol | null>(null);

  const [initializingClient, setInitializingClient] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  const [balance, setBalance] = useState("0");

  const [limit, setLimit] = useState("0");

  const refresh = useCallback(() => {
    const summary = current.current?.utxoByMint.get(SOL_POOL_MINT);
    setBalance(summary?.totalAmount.toString() ?? "0");
    setLimit(summary?.maxSingleTxAmount.toString() ?? "0");
  }, []);

  const close = useCallback(() => {
    generation.current++;
    const previous = current.current;
    current.current = null;
    void previous?.stopClient();
  }, []);

  useEffect(() => {
    close();
    initializing.current = false;
    setInitializingClient(false);
    setClient(null);
    setBalance("0");
    setLimit("0");
    return close;
  }, [address, close]);

  useEffect(() => {
    if (!client) return;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [client, refresh]);

  const initialize = useCallback(async () => {
    if (initializing.current || current.current) return;
    if (!publicKey || !signMessage || !signTransaction)
      throw new Error(
        "Connect a wallet that supports message and transaction signing.",
      );
    setError("");
    initializing.current = true;
    setInitializingClient(true);
    const version = generation.current;
    try {
      const { CharonProtocol } = await import("charonprotocol-sdk");
      if (version !== generation.current) return;
      const instance = await CharonProtocol.generateClient({
        rpcUrl: RPC_URL,
        owner: {
          publicKey,
          signMessage: sessionSignMessage(publicKey.toBase58(), signMessage),
          signTransaction: async (tx) => {
            progress.current?.("signing");
            const signed = await signTransaction(tx);
            progress.current?.("confirming");
            return signed;
          },
        },
      });
      if (version !== generation.current) {
        await instance.stopClient();
        return;
      }
      current.current = instance;
      setClient(instance);
      refresh();
    } catch (cause) {
      if (version === generation.current) {
        setError(cause instanceof Error ? cause.message : "Unable to initialize your account.");
      }
    } finally {
      if (version === generation.current) {
        initializing.current = false;
        setInitializingClient(false);
      }
    }
  }, [publicKey, signMessage, signTransaction, refresh]);

  useEffect(() => {
    if (enabled && publicKey && signMessage && signTransaction) void initialize();
  }, [enabled, publicKey, signMessage, signTransaction, initialize, attempt]);

  return {
    client,
    disconnect,
    initializingClient,
    error,
    retry: () => setAttempt((value) => value + 1),
    balance,
    limit,
    refresh,
    address,
    observeProgress,
  };
}
