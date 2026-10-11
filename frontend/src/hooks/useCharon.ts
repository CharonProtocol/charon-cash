import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import type { CharonProtocol } from "charonprotocol-sdk";
import { RPC_URL } from "../lib/config";
import { describePaymentError, SOL_POOL_MINT } from "../lib/payment";
import { sessionSignMessage } from "../lib/sessionSeed";
import { SUPPORTED_SPL_MINTS } from "./usePaymentTransaction";
import type { TransactionStage } from "../components/dashboard/types";

const NATIVE_SOL_MINT = "11111111111111111111111111111111";

function rawFor(client: CharonProtocol, mint: string): bigint {
  const direct = client.utxoByMint.get(mint);
  if (direct) return BigInt(direct.totalAmount.toString(10));
  let target: PublicKey;
  try {
    target = new PublicKey(mint);
  } catch {
    return 0n;
  }
  for (const [key, summary] of client.utxoByMint) {
    try {
      if (new PublicKey(key).equals(target)) {
        return BigInt(summary.totalAmount.toString(10));
      }
    } catch {
      continue;
    }
  }
  return 0n;
}

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

  const [holdings, setHoldings] = useState<Record<string, string>>({});

  const refresh = useCallback(() => {
    const instance = current.current;
    if (!instance) {
      setHoldings({});
      setBalance("0");
      setLimit("0");
      return;
    }
    const sol = (rawFor(instance, SOL_POOL_MINT) + rawFor(instance, NATIVE_SOL_MINT)).toString();
    const next: Record<string, string> = { [SOL_POOL_MINT]: sol };
    for (const mint of Object.values(SUPPORTED_SPL_MINTS)) {
      next[mint] = rawFor(instance, mint).toString();
    }
    const summary = instance.utxoByMint.get(SOL_POOL_MINT);
    setHoldings(next);
    setBalance(sol);
    setLimit(summary?.maxSingleTxAmount.toString(10) ?? "0");
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
    setHoldings({});
    return close;
  }, [address, close]);

  useEffect(() => {
    if (!client) return;
    refresh();
    client.requestNoteScan();
    return client.watchBalances(refresh);
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
        setError(
          describePaymentError(
            cause instanceof Error
              ? cause.message
              : "Unable to open your account.",
          ),
        );
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
    holdings,
    limit,
    refresh,
    address,
    observeProgress,
  };
}
