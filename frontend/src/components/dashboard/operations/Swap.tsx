import { OperationLayout } from "../OperationLayout";
import { useState, type FormEvent } from "react";
import { parseTokenAmount } from "../../../lib/payment";
import { SWAP_AVAILABLE } from "../../../lib/config";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { TokenIcon, type Token } from "../TokenIcon";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";
import {
  PAY_AMOUNT,
  PAY_ERROR,
  PAY_FORM,
} from "../payUi";

export function Swap({ context }: { context: PaymentContext }) {
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState("");
  const [fromToken, setFromToken] = useState<Token>(context.token);
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
      if (!SWAP_AVAILABLE) throw new Error("Private swap will be available on mainnet.");
      validate();
      if (!context.connected) throw new Error("Connect your wallet to continue.");
      if (!context.client) throw new Error("Your account is still initializing.");
      setValidation("");
      setStep(1);
      const outcome = await transaction.submit(amount, "", fromToken, toToken);
      if (outcome?.formError) {
        setValidation(outcome.formError);
        setStep(0);
      }
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
          <div className="pay-amount-row">
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
            <TokenSelector
              value={fromToken}
              onChange={(next) => {
                setFromToken(next);
                context.onTokenChange(next);
                setAmount("");
              }}
            />
          </div>
          <div className="pay-available">
            <span>
              Available {context.available} {fromToken}
            </span>
            <button
              type="button"
              className="pay-max"
              onClick={() => setAmount(context.available)}
            >
              Max
            </button>
          </div>
          <div className="pay-summary">
            <TokenIcon token={toToken} className="size-5" />
            {toToken}
          </div>
          <TokenSelector value={toToken} onChange={setToToken} />
          {!SWAP_AVAILABLE && (
            <p className="pay-available" role="status">
              Private swap will be available on mainnet. On devnet you can deposit, send, transfer and withdraw.
            </p>
          )}
          {validation && (
            <p className={PAY_ERROR} role="alert">
              {validation}
            </p>
          )}
          <button
            type="submit"
            className="pay-review"
            disabled={!SWAP_AVAILABLE || !amount || context.paymentsBlocked}
            aria-label="Swap"
          >
            {SWAP_AVAILABLE ? "Review swap" : "Available on mainnet"}
          </button>
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
