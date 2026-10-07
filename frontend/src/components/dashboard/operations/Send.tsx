import { OperationLayout } from "../OperationLayout";
import { useRef, useState, type FormEvent } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { parseTokenAmount } from "../../../lib/payment";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { TokenIcon, type Token } from "../TokenIcon";
import { StepIndicator } from "../StepIndicator";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";

const ENTRY_ROW = "relative flex items-center justify-center pr-12 sm:px-20";
const NEXT_BUTTON =
  "absolute right-0 grid size-11 place-items-center rounded-full bg-transparent text-[#111] enabled:hover:bg-neutral-100 disabled:opacity-30 sm:right-3 [&_svg]:size-9";
const NOTE =
  "mx-auto mt-2 max-w-lg text-center text-[10px] leading-relaxed text-neutral-500 [@media(max-height:560px)]:mt-1 [@media(max-height:560px)]:text-[9px]";
const INPUT_RESET =
  "outline-none! focus:outline-none! focus-visible:outline-none! ring-0! focus:ring-0!";

export function Send({ context }: { context: PaymentContext }) {
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<Token>("SOL");
  const [recipient, setRecipient] = useState("");
  const [validation, setValidation] = useState("");
  const transaction = usePaymentTransaction("send", context);
  const reduced = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);
  const processingStep = 2;
  const validate = () => {
    const units = parseTokenAmount(amount, token);
    return units;
  };
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
      await transaction.submit(amount, recipient, token);
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
  const accountControls = (
    <>
      {!context.connected ? (
        <WalletMultiButton />
      ) : (
        <span className="text-[9px] text-neutral-500">
          The arrow requests your wallet signature.
        </span>
      )}
    </>
  );
  const errorMessage = validation && (
    <p
      id="pay-validation"
      role="alert"
      className="mx-auto mt-2 max-w-xl text-center text-xs leading-snug wrap-anywhere text-red-800 [@media(max-height:560px)]:mt-1 [@media(max-height:560px)]:text-[10px]"
    >
      {validation}
    </p>
  );
  return (
    <OperationLayout
      title="Send"
      direction="wallet to private"
    >
      <div className="flex min-h-0 flex-1 flex-col justify-between items-stretch gap-2">
        <AnimatePresence
          mode="wait"
          initial={false}
        >
          <m.div
            key={step}
            className="flex min-h-0 w-full flex-1 flex-col gap-3  items-stretch [@media(max-height:560px)]:gap-2"
            initial={{ opacity: 0, y: reduced ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduced ? 0 : -6 }}
            transition={{ duration: reduced ? 0 : 0.18 }}
            onAnimationComplete={() => {
              if (step === 1) heading.current?.focus();
            }}
          >
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
                <TokenSelector
                  value={token}
                  onChange={(next) => {
                    setToken(next);
                    setValidation("");
                  }}
                />
                <h2
                  className="shrink-0 text-[clamp(14px,2.5dvh,21px)] font-normal text-neutral-500 outline-none!"
                  ref={heading}
                  tabIndex={-1}
                >
                  {step === 0
                    ? `Enter the Amount of ${token} : `
                    : "Enter the recipient’s wallet address"}
                </h2>
                {step === 0 ? (
                  <form
                    className="grow flex min-h-0 w-full flex-1 flex-col justify-center"
                    onSubmit={advance}
                  >
                    <div className={ENTRY_ROW}>
                      <label
                        className="sr-only"
                        htmlFor="pay-amount"
                      >
                        Amount in {token}
                      </label>
                      <input
                        id="pay-amount"
                        className={`min-w-0 w-full max-w-xl border-0 bg-transparent py-1.5 text-center text-[clamp(40px,9dvh,76px)]! tracking-[-3px] text-neutral-800 placeholder:text-neutral-500 [@media(max-height:560px)]:py-0 [@media(max-height:560px)]:text-[44px]! ${INPUT_RESET}`}
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => {
                          setAmount(event.target.value);
                          setValidation("");
                        }}
                        placeholder="0.00"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="pay-validation pay-balance"
                      />
                      <button
                        className={NEXT_BUTTON}
                        aria-label="Continue to recipient"
                        type="submit"
                      >
                        <ArrowRight strokeWidth={1} />
                      </button>
                    </div>
                    <div className="mx-auto mt-[clamp(6px,1.5dvh,14px)]">
                      <TokenIcon
                        token={token}
                        className="size-6 shrink-0 [@media(max-height:560px)]:size-4"
                      />
                    </div>
                    <p
                      className={NOTE}
                      id="pay-balance"
                    >
                      {`Wallet ${token} → private account`}
                    </p>
                    {errorMessage}
                  </form>
                ) : (
                  <form
                    className="grow flex min-h-0 w-full flex-1 flex-col justify-center"
                    onSubmit={confirm}
                  >
                    <div className={ENTRY_ROW}>
                      <label
                        className="sr-only"
                        htmlFor="pay-recipient"
                      >
                        Recipient Solana wallet address
                      </label>
                      <input
                        id="pay-recipient"
                        className={`min-w-0 w-full max-w-lg border-0 bg-transparent px-3 py-2.5 text-xs! text-neutral-800 placeholder:text-neutral-500 ${INPUT_RESET}`}
                        value={recipient}
                        onChange={(event) => {
                          setRecipient(event.target.value);
                          setValidation("");
                        }}
                        placeholder="Recipient wallet address"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="pay-recipient-hint pay-validation"
                      />
                      <button
                        className={NEXT_BUTTON}
                        aria-label="Confirm private payment"
                        type="submit"
                        disabled={!context.client}
                      >
                        <ArrowRight strokeWidth={1} />
                      </button>
                    </div>
                    <div className="mx-auto mt-4 flex w-full max-w-lg items-center justify-end gap-3 text-xs text-neutral-600 [@media(max-height:560px)]:mt-1.5">
                      <span>Amount to send</span>
                      <strong className="text-lg font-normal text-neutral-900">
                        {amount}
                      </strong>
                      <TokenIcon
                        token={token}
                        className="size-5 shrink-0"
                      />
                    </div>
                    <p
                      className={NOTE}
                      id="pay-recipient-hint"
                    >
                      {
                        "Send from your wallet into a registered recipient’s private account."
                      }
                    </p>
                    <div className="mx-auto mt-3 flex w-full max-w-lg items-center justify-between gap-3 [@media(max-height:560px)]:mt-1.5">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 bg-transparent py-1 text-[11px]! text-neutral-600"
                        onClick={() => {
                          setStep(0);
                          setValidation("");
                        }}
                      >
                        <ArrowLeft size={15} />
                        Edit amount
                      </button>
                      {accountControls}
                    </div>
                    {errorMessage}
                  </form>
                )}
              </>
            )}
          </m.div>
        </AnimatePresence>
        <StepIndicator
          step={step}
          labels={["Amount", "Recipient", "Transaction"]}
        />
      </div>
    </OperationLayout>
  );
}
