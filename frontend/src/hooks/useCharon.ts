import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { CharonProtocol } from "charonprotocol-sdk";
import { RPC_URL } from "../lib/config";
import { SOL_POOL_MINT } from "../lib/payment";
import type { TransactionStage } from "../components/dashboard/types";

export function useCharon() {
  const { publicKey, signMessage, signTransaction } = useWallet();
  const address = publicKey?.toBase58();
  const current = useRef<CharonProtocol | null>(null);
  const generation = useRef(0);
  const progress = useRef<((stage: TransactionStage) => void) | null>(null);
  const observeProgress = (listener: ((stage: TransactionStage) => void) | null) => { progress.current = listener; };
  const initializing = useRef(false);
  const [client, setClient] = useState<CharonProtocol | null>(null);
  const [unlocking, setUnlocking] = useState(false);
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
    setUnlocking(false);
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
  const unlock = async () => {
    if (initializing.current || current.current) return;
    if (!publicKey || !signMessage || !signTransaction)
      throw new Error(
        "Connect a wallet that supports message and transaction signing.",
      );
    initializing.current = true;
    setUnlocking(true);
    const version = generation.current;
    try {
      const { CharonProtocol, configureProver } =
        await import("charonprotocol-sdk");
      configureProver({ circuitBaseUrl: "/circuit/", proverBaseUrl: "/prover/" });
      if (version !== generation.current) return;
      const instance = await CharonProtocol.generateClient({
        rpcUrl: RPC_URL,
        owner: { publicKey, signMessage, signTransaction: async tx => {
          progress.current?.("signing");
          const signed = await signTransaction(tx);
          progress.current?.("confirming");
          return signed;
        } },
      });
      if (version !== generation.current) {
        await instance.stopClient();
        return;
      }
      current.current = instance;
      setClient(instance);
      refresh();
    } finally {
      if (version === generation.current) {
        initializing.current = false;
        setUnlocking(false);
      }
    }
  };
  return { client, unlocking, unlock, balance, limit, refresh, address, observeProgress };
}
