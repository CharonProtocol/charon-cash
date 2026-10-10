import { OperationLayout } from "../OperationLayout";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import { formatSol } from "../../../lib/amount";
import { parseTokenAmount } from "../../../lib/payment";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { type Token } from "../TokenIcon";
import { StepIndicator } from "../StepIndicator";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";
import {
  PAY_AMOUNT,
  PAY_ENTRY,
  PAY_ERROR,
  PAY_FLOW,
  PAY_FORM,
  PAY_NEXT,
} from "../payUi";

export function Withdraw({ context }: { context: PaymentContext }) {
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<Token>("SOL");
  const [validation, setValidation] = useState("");
  const transaction = usePaymentTransaction("withdraw", context);
  const heading = useRef<HTMLHeadingElement>(null);
  const processingStep = 1;
  const describedBy = validation ? "pay-validation" : undefined;
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const validate = () => {
    const units = parseTokenAmount(amount, token);
    if (
      token === "SOL" &&
      context.client &&
      BigInt(units) > BigInt(context.limit)
    ) {
      throw new Error(
        `Available in one transaction: ${formatSol(context.limit)} SOL.`,
      );
    }
    return units;
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    try {
      validate();
      if (!context.connected)
        throw new Error("Connect your wallet to continue.");
      if (!context.client)
        throw new Error("Your account is still initializing.");
      setValidation("");
      setStep(processingStep);
      await transaction.submit(amount, "", token);
    } catch (cause) {
      setValidation(
        cause instanceof Error ? cause.message : "Check the payment details.",
      );
    }
  };
  const reset = () => {
    transaction.reset();
    setStep(0);
    setAmount("");
    setValidation("");
  };
  const units = (() => {
    try {
      return parseTokenAmount(amount, token);
    } catch {
      return 0;
    }
  })();
  const fee = token === "SOL" ? Math.ceil((units * 25) / 10000) : 0;
  const errorMessage = validation && (
    <p
      id="pay-validation"
      role="alert"
      className={PAY_ERROR}
    >
      {validation}
    </p>
  );
  return (
    <OperationLayout>
      <div className={PAY_FLOW}>
        {step === processingStep ? (
          <ProcessingStep
            status={transaction.status}
            kind="withdraw"
            amount={amount}
            token={token}
            error={transaction.error}
            explorerUrl={transaction.explorerUrl}
            onReset={reset}
            onBack={() => {
              transaction.reset();
              setStep(0);
            }}
          />
        ) : (
          <>
            <h2
              className="sr-only"
              ref={heading}
              tabIndex={-1}
            >
              {`Amount in ${token}`}
            </h2>
            <TokenSelector
              value={token}
              onChange={(next) => {
                setToken(next);
                setValidation("");
              }}
            />
            <form
              className={PAY_FORM}
              onSubmit={confirm}
            >
              <div className={PAY_ENTRY}>
                <label
                  className="sr-only"
                  htmlFor="pay-amount"
                >
                  Amount in {token}
                </label>
                <input
                  id="pay-amount"
                  className={PAY_AMOUNT}
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setValidation("");
                  }}
                  placeholder="0.00"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(validation)}
                  aria-describedby={describedBy}
                />
                <button
                  className={PAY_NEXT}
                  aria-label="Withdraw to connected wallet"
                  type="submit"
                >
                  <ArrowRight strokeWidth={1.4} />
                </button>
              </div>
              {token === "SOL" && units > fee && (
                <p className="pay-fee">
                  Fee {formatSol(String(fee))} · Receive{" "}
                  {formatSol(String(units - fee))}
                </p>
              )}
              {errorMessage}
            </form>
          </>
        )}
      </div>
      <StepIndicator
        step={step}
        labels={["Amount", "Withdraw"]}
      />
    </OperationLayout>
  );
}
