import { OperationLayout } from "../OperationLayout";
import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { parseTokenAmount } from "../../../lib/payment";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { TokenIcon, type Token } from "../TokenIcon";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";

const NOTE =
  "mx-auto mt-2 max-w-lg text-center text-[10px] leading-relaxed text-neutral-500";

export function Swap({ context }: { context: PaymentContext }) {
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState("");
  const [fromToken, setFromToken] = useState<Token>("SOL");
  const [toToken, setToToken] = useState<Token>("USDC");
  const [validation, setValidation] = useState("");
  const transaction = usePaymentTransaction("swap", context);

  const validate = () => {
    if (fromToken === toToken) throw new Error("Choose a different output asset.");
    if (fromToken !== "SOL" && toToken !== "SOL") {
      throw new Error("Swap SOL with USDC or USDT.");
    }
    return parseTokenAmount(amount, fromToken);
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    try {
      validate();
      if (!context.connected) throw new Error("Connect your wallet to continue.");
      if (!context.client) throw new Error("Your account is still initializing.");
      setValidation("");
      setStep(1);
      await transaction.submit(amount, "", fromToken, toToken);
    } catch (cause) {
      setValidation(cause instanceof Error ? cause.message : "Check the swap details.");
    }
  };

  const reset = () => {
    transaction.reset();
    setStep(0);
    setAmount("");
    setValidation("");
  };

  return (
    <OperationLayout title="Swap" direction="private asset exchange">
      {step === 0 ? (
        <form className="swap-form flex min-h-0 flex-1 flex-col justify-between" onSubmit={confirm}>
          <div className="swap-content flex flex-col items-center gap-4">
            <h2 className="swap-amount-label">Enter the Amount of {fromToken}</h2>
            <TokenSelector value={fromToken} onChange={setFromToken} />
            <div className="swap-amount-row relative flex items-center justify-center pr-14">
              <label className="flex items-baseline justify-center gap-2">
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  placeholder="0"
                  aria-label="Amount to swap"
                  className="w-40 bg-transparent text-center text-4xl outline-none"
                />
                <span className="text-sm text-neutral-500">{fromToken}</span>
              </label>
              <button
                type="submit"
                className="absolute right-0 grid size-11 place-items-center rounded-full enabled:hover:bg-neutral-100 disabled:opacity-30"
                disabled={!amount}
                aria-label="Swap"
              >
                <ArrowRight className="size-9" />
              </button>
            </div>
            <p className="text-xs text-neutral-500">to</p>
            <div className="flex items-center gap-2 text-lg">
              <TokenIcon token={toToken} className="size-6" />
              {toToken}
            </div>
            <TokenSelector value={toToken} onChange={setToToken} />
            {validation && (
              <p className="text-center text-xs text-red-600" role="alert">
                {validation}
              </p>
            )}
            <p className={NOTE}>
              The swap stays inside the pool. Jupiter fills it, and the relayer submits the transaction.
            </p>
          </div>
          <div className="flex justify-center">
            {!context.connected ? <WalletMultiButton /> : <span />}
          </div>
        </form>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ProcessingStep
            status={transaction.status}
            kind="swap"
            amount={amount}
            token={fromToken}
            error={transaction.error || validation}
            explorerUrl={transaction.explorerUrl}
            onReset={reset}
            onBack={() => {
              transaction.reset();
              setStep(0);
            }}
          />
          {transaction.status === "idle" && (
            <button type="button" onClick={() => setStep(0)} aria-label="Back">
              <ArrowLeft />
            </button>
          )}
        </div>
      )}
    </OperationLayout>
  );
}
