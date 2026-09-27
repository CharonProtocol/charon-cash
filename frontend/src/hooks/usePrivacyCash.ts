import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { SilentPay } from "privacy-cash-sdk";

export function usePrivacyCash() {
  const { publicKey, signMessage, signTransaction } = useWallet();

  const [client, setClient] = useState<SilentPay | null>(null);

  const connected = !!(publicKey && signMessage && signTransaction);
  const pubkeyStr = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!connected || !publicKey || !signMessage || !signTransaction) {
      setClient(null);
      return;
    }

    let cancelled = false;
    let localClient: SilentPay | null = null;

    async function initialize() {
      const newClient = await SilentPay.generateClient({
        rpcUrl: "http://127.0.0.1:8899",
        owner: {
          publicKey: publicKey!,
          signMessage: signMessage!,
          signTransaction: signTransaction!,
        },
      });

      if (cancelled) {
        newClient.stopClient();
        return;
      }
      localClient = newClient;
      setClient(newClient);
    }

    initialize();

    return () => {
      cancelled = true;
      if (localClient) localClient.stopClient();
    };
  }, [connected, pubkeyStr]); // only re-run when the actual wallet identity changes

  return {
    client,
    connected,
    publicKey,
  };
}
