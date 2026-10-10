import { OperationLayout } from "../OperationLayout";
import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { parseTokenAmount } from "../../../lib/payment";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { TokenIcon, type Token } from "../TokenIcon";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";
import {
  PAY_AMOUNT,
  PAY_ENTRY,
  PAY_ERROR,
  PAY_FORM,
  PAY_NEXT,
} from "../payUi";

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
    <OperationLayout>
      {step === 0 ? (
        <form className={PAY_FORM} onSubmit={confirm}>
          <TokenSelector value={fromToken} onChange={setFromToken} />
          <div className={PAY_ENTRY}>
            <label className="sr-only" htmlFor="swap-amount">
              Amount to swap
            </label>
            <input
              id="swap-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              aria-label="Amount to swap"
              className={PAY_AMOUNT}
            />
            <button
              type="submit"
              className={PAY_NEXT}
              disabled={!amount}
              aria-label="Swap"
            >
              <ArrowRight strokeWidth={1.4} />
            </button>
          </div>
          <div className="pay-summary">
            <TokenIcon token={toToken} className="size-5" />
            {toToken}
          </div>
          <TokenSelector value={toToken} onChange={setToToken} />
          {validation && (
            <p className={PAY_ERROR} role="alert">
              {validation}
            </p>
          )}
          {!context.connected && (
            <div className="mt-4 flex justify-center">
              <WalletMultiButton />
            </div>
          )}
        </form>
      ) : (
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
      )}
    </OperationLayout>
  );
}
