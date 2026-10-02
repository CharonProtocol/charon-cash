import { useRef, useState, type FormEvent } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { formatSol } from "../../../lib/amount";
import { assertPaymentSupported, parseTokenAmount } from "../../../lib/payment";
import { usePaymentTransaction } from "../../../hooks/usePaymentTransaction";
import { TokenSelector } from "../TokenSelector";
import { TokenIcon, type Token } from "../TokenIcon";
import { StepIndicator } from "../StepIndicator";
import { ProcessingStep } from "../ProcessingStep";
import type { PaymentContext } from "../types";

const ENTRY_ROW = "relative flex items-center justify-center pr-12 sm:px-20";
const NEXT_BUTTON =
  "absolute right-0 grid size-11 place-items-center rounded-full bg-transparent text-[#111] enabled:hover:bg-neutral-100 disabled:opacity-30 sm:right-3 [&_svg]:size-9";
const FORM = "flex min-h-0 w-full flex-1 flex-col justify-center";
const NOTE =
  "mx-auto mt-2 max-w-lg text-center text-[10px] leading-relaxed text-neutral-500 [@media(max-height:560px)]:mt-1 [@media(max-height:560px)]:text-[9px]";
const INPUT_RESET =
  "outline-none! focus:outline-none! focus-visible:outline-none! ring-0! focus:ring-0!";

export function Withdraw({ context }: { context: PaymentContext }) {
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<Token>("SOL");
  const [validation, setValidation] = useState("");
  const transaction = usePaymentTransaction("withdraw", context);
  const reduced = useReducedMotion();
  const heading = useRef<HTMLHeadingElement>(null);
  const processingStep = 1;
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
      assertPaymentSupported("withdraw", token);
      if (!context.connected)
        throw new Error("Connect your wallet to continue.");
      if (!context.client) throw new Error("Unlock your account to continue.");
      setValidation("");
      setStep(processingStep);
      await transaction.submit(amount, "", token);
    } catch (cause) {
      setValidation(
        cause instanceof Error ? cause.message : "Check the payment details.",
      );
    }
  };
  const unlock = async () => {
    try {
      setValidation("");
      await context.unlock();
    } catch (cause) {
      setValidation(
        cause instanceof Error ? cause.message : "Unable to unlock account.",
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
  const fee =
    token === "SOL" ? Math.ceil((units * 25) / 10000) : 0;
  const accountControls = (
    <>
      {!context.connected ? (
        <WalletMultiButton />
      ) : !context.client ? (
        <button
          type="button"
          className="rounded-md bg-[#303030] px-3 py-2 text-xs! text-white disabled:opacity-40 [@media(max-height:560px)]:py-1"
          disabled={context.unlocking}
          onClick={() => void unlock()}
        >
          {context.unlocking ? "Unlocking…" : "Unlock account"}
        </button>
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
    <div className="relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3 [@media(max-height:560px)]:gap-1.5">
      <AnimatePresence
        mode="wait"
        initial={false}
      >
        <m.div
          key={step}
          className="flex min-h-0 flex-col [@media(max-height:560px)]:grid [@media(max-height:560px)]:grid-cols-[100px_minmax(0,1fr)] [@media(max-height:560px)]:grid-rows-[auto_minmax(0,1fr)] [@media(max-height:560px)]:gap-x-3 [@media(max-height:560px)]:gap-y-1.5"
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduced ? 0 : -6 }}
          transition={{ duration: reduced ? 0 : 0.18 }}
          onAnimationComplete={() => {
            heading.current?.focus();
          }}
        >
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
                className="col-span-full mb-[clamp(8px,2dvh,18px)] shrink-0 text-[clamp(14px,2.5dvh,21px)] font-normal tracking-tight text-neutral-500 outline-none! [@media(max-height:560px)]:mb-0 [@media(max-height:560px)]:text-[13px]"
                ref={heading}
                tabIndex={-1}
              >
                Enter the amount
              </h2>
              <TokenSelector
                value={token}
                onChange={(next) => {
                  setToken(next);
                  setValidation("");
                }}
              />
              <form
                  className={FORM}
                  onSubmit={confirm}
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
                      aria-label="Withdraw to connected wallet"
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
                    {token !== "SOL"
                      ? `Private ${token} → connected wallet`
                      : context.client
                        ? `Private balance · ${formatSol(context.limit)} SOL available per transaction`
                        : "Unlock your account to see your private balance"}
                  </p>
                  <>
                      <p className={NOTE}>
                        To your connected wallet
                        {context.address
                          ? ` · ${context.address.slice(0, 4)}…${context.address.slice(-4)}`
                          : ""}
                      </p>
                      {token === "SOL" && units > fee && (
                        <p className={NOTE}>
                          Fee: {formatSol(String(fee))} SOL · You receive{" "}
                          {formatSol(String(units - fee))} SOL
                        </p>
                      )}
                      <div className="mt-2 flex justify-center">
                        {accountControls}
                      </div>
                  </>
                  {errorMessage}
              </form>
            </>
          )}
        </m.div>
      </AnimatePresence>
      <StepIndicator
        step={step}
        labels={["Amount", "Withdraw"]}
      />
    </div>
  );
}
