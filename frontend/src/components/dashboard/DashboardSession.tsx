import { useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCharon } from "../../hooks/useCharon";
import { formatTokenAmount, SOL_POOL_MINT } from "../../lib/payment";
import { SUPPORTED_SPL_MINTS } from "../../hooks/usePaymentTransaction";
import { UserAgreement } from "./UserAgreement";
import type { Token } from "./TokenIcon";
import type { PaymentContext } from "./types";

type Props = {
  children: (account: Omit<PaymentContext, "onBusyChange">) => ReactNode;
};

export function DashboardSession({ children }: Props) {
  const { publicKey } = useWallet();
  return (
    <WalletSession key={publicKey?.toBase58() ?? "disconnected"}>
      {children}
    </WalletSession>
  );
}

function WalletSession({ children }: Props) {
  const { publicKey, connected, signMessage, signTransaction } = useWallet();
  const agreementKey = `charon:user-agreement:v1:${publicKey?.toBase58() ?? "disconnected"}`;
  const [accepted, setAccepted] = useState(() => {
    try {
      return !!publicKey && localStorage.getItem(agreementKey) === "accepted";
    } catch {
      return false;
    }
  });
  const account = useCharon(accepted);
  const [token, setToken] = useState<Token>("SOL");
  const mint =
    token === "SOL"
      ? SOL_POOL_MINT
      : SUPPORTED_SPL_MINTS[token.toLowerCase() as "usdc" | "usdt"];
  const available = formatTokenAmount(account.holdings[mint] ?? "0", token);
  const unsupported = connected && (!signMessage || !signTransaction);
  const pending = accepted && connected && !account.client;
  const agree = () => {
    try {
      localStorage.setItem(agreementKey, "accepted");
    } catch {
      /* Continue for this session when storage is unavailable. */
    }
    setAccepted(true);
  };
  return (
    <>
      <div inert={!accepted || pending || undefined}>
        {children({
          ...account,
          connected,
          token,
          onTokenChange: setToken,
          available,
          paymentsBlocked: false,
        })}
      </div>
      {!accepted && (
        <UserAgreement
          connected={connected}
          onAgree={agree}
        />
      )}
      {pending && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-5 font-mono">
          <div
            role="status"
            aria-live="polite"
            className="w-full max-w-md rounded-xl bg-white p-6 text-center text-xs text-[#111]"
          >
            <p>
              {unsupported
                ? "Connect a wallet that supports message and transaction signing."
                : account.error ||
                  "Preparing your private account. Approve the message in your wallet."}
            </p>
            {(account.error || unsupported) && (
              <div className="mt-4 flex justify-center gap-4">
                <button
                  type="button"
                  onClick={() => void account.retry()}
                  disabled={unsupported}
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => void account.disconnect()}
                >
                  Disconnect wallet
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
