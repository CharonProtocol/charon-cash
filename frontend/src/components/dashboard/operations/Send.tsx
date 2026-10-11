import { OperationLayout } from "../OperationLayout";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { PublicKey } from "@solana/web3.js";
import { parseTokenAmount } from "../../../lib/payment";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { StepIndicator } from "../StepIndicator";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";
import {
  PAY_AMOUNT,
  PAY_BACK,
  PAY_FIELD,
  PAY_ERROR,
  PAY_FLOW,
  PAY_FORM,
  PAY_RECIPIENT,
} from "../payUi";

export function Send({ context }: { context: PaymentContext }) {
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState("");
  const token = context.token;
  const [recipient, setRecipient] = useState("");
  const [validation, setValidation] = useState("");
  const transaction = usePaymentTransaction("send", context);
  const heading = useRef<HTMLHeadingElement>(null);
  const processingStep = 2;
  const describedBy = validation ? "pay-validation" : undefined;
  useEffect(() => {
    if (step === 1) heading.current?.focus();
  }, [step]);
  const validate = () => parseTokenAmount(amount, token);
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    try {
      validate();
      try {
        new PublicKey(recipient.trim());
      } catch {
        throw new Error("Enter a valid Solana wallet address.");
      }
      if (!context.connected)
        throw new Error("Connect your wallet to continue.");
      if (!context.client)
        throw new Error("Your account is still initializing.");
      setValidation("");
      setStep(processingStep);
      const outcome = await transaction.submit(amount, recipient, token);
      if (outcome?.formError) {
        setValidation(outcome.formError);
        setStep(1);
      }
    } catch (cause) {
      setValidation(
        cause instanceof Error ? cause.message : "Check the payment details.",
      );
    }
  };
  const advance = (event: FormEvent) => {
    event.preventDefault();
    try {
      validate();
      setValidation("");
      setStep(1);
    } catch (cause) {
      setValidation(
        cause instanceof Error ? cause.message : "Check the amount.",
      );
    }
  };
  const reset = () => {
    transaction.reset();
    setStep(0);
    setAmount("");
    setRecipient("");
    setValidation("");
  };
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
            kind="send"
            amount={amount}
            token={token}
            error={transaction.error}
            explorerUrl={transaction.explorerUrl}
            onReset={reset}
            onBack={() => {
              transaction.reset();
              setStep(1);
            }}
          />
        ) : (
          <>
            <h2
              className="sr-only"
              ref={heading}
              tabIndex={-1}
            >
              {step === 0 ? `Amount in ${token}` : "Recipient"}
            </h2>
            {step === 0 ? (
              <form
                className={PAY_FORM}
                onSubmit={advance}
              >
                <div className="pay-amount-row">
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
                  <TokenSelector
                    value={token}
                    locked={false}
                    onChange={(next) => {
                      context.onTokenChange(next);
                      setAmount("");
                      setValidation("");
                    }}
                  />
                </div>
                <div className="pay-available">
                  <span>
                    Available {context.available} {token}
                  </span>
                  <button
                    type="button"
                    className="pay-max"
                    onClick={() => {
                      setAmount(context.available);
                      setValidation("");
                    }}
                  >
                    Max
                  </button>
                </div>
                <button
                  className="pay-review"
                  aria-label="Continue to recipient"
                  type="submit"
                  disabled={context.paymentsBlocked}
                >
                  Continue
                </button>
                {errorMessage}
              </form>
            ) : (
              <form
                className={PAY_FORM}
                onSubmit={confirm}
              >
                    <div className={PAY_FIELD}>
                      <label
                        className="sr-only"
                        htmlFor="pay-recipient"
                      >
                    Recipient Solana wallet address
                  </label>
                  <input
                    id="pay-recipient"
                    className={PAY_RECIPIENT}
                    value={recipient}
                    onChange={(event) => {
                      setRecipient(event.target.value);
                      setValidation("");
                    }}
                    placeholder="Recipient address"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(validation)}
                    aria-describedby={describedBy}
                  />
                </div>
                <button
                  className="pay-review"
                  aria-label="Confirm private payment"
                  type="submit"
                  disabled={context.paymentsBlocked}
                >
                  Review send
                </button>
                <div className="pay-summary">
                  <strong>
                    {amount} {token}
                  </strong>
                </div>
                <div className="pay-actions">
                  <button
                    type="button"
                    className={PAY_BACK}
                    onClick={() => {
                      setStep(0);
                      setValidation("");
                    }}
                  >
                    <ArrowLeft size={15} />
                    Edit amount
                  </button>
                </div>
                {errorMessage}
              </form>
            )}
          </>
        )}
      </div>
      <StepIndicator
        step={step}
        labels={["Amount", "Recipient", "Transaction"]}
      />
    </OperationLayout>
  );
}
