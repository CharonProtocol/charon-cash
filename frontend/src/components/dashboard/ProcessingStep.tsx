import { m, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check, Wallet, AlertCircle } from "lucide-react";
import { ShieldIcon } from "./ShieldIcon";
import type { Token } from "./TokenIcon";
import type { PaymentKind, PaymentStatus } from "./types";

const LABELS: Record<PaymentStatus, [string, string]> = {
  idle: ["Ready", ""],
  unlocking: [
    "Unlocking your account",
    "Approve the sign-in message in your wallet.",
  ],
  proof: [
    "Creating your private proof",
    "Your browser is preparing the transaction.",
  ],
  signing: [
    "Approve in your wallet",
    "Review and sign the transaction to continue.",
  ],
  confirming: [
    "Confirming your transaction",
    "Waiting for confirmation on Solana.",
  ],
  success: ["Transaction confirmed", "Your payment is complete."],
  error: [
    "Transaction didn’t complete",
    "Your entries are saved. You can review them and try again.",
  ],
};
export function ProcessingStep({
  status,
  kind,
  amount,
  token = "SOL",
  error,
  explorerUrl,
  onReset,
  onBack,
}: {
  status: PaymentStatus;
  kind: PaymentKind;
  amount: string;
  token?: Token;
  error?: string;
  explorerUrl?: string;
  onReset: () => void;
  onBack: () => void;
}) {
  const reduced = useReducedMotion();
  const done = status === "success";
  const failed = status === "error";
  const Source = kind === "send" ? Wallet : ShieldIcon;
  const Target = kind === "withdraw" ? Wallet : ShieldIcon;
  return (
    <div
      className="col-span-full row-span-full flex h-full min-h-0 flex-col items-center justify-center px-4 text-center"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className="mb-[clamp(8px,3dvh,24px)] flex items-center"
        aria-hidden="true"
      >
        <span className="grid size-12 place-items-center rounded-xl border border-neutral-300 bg-white [@media(max-height:560px)]:size-9 [&_svg]:size-6">
          <Source
            size={28}
            strokeWidth={1.4}
          />
        </span>
        <div className="relative mx-3 h-px w-[clamp(60px,10vw,120px)] bg-neutral-200">
          <m.span
            className="absolute -top-[4.5px] size-2.5 -translate-x-1/2 rounded-full bg-[#303030]"
            animate={
              done || failed || reduced
                ? { left: done ? "100%" : "50%", opacity: 1 }
                : { left: ["0%", "100%"], opacity: [0, 1, 1, 0] }
            }
            transition={
              done || failed || reduced
                ? { duration: 0.2 }
                : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }
            }
          />
        </div>
        <m.span
          className="grid size-12 place-items-center rounded-xl border border-neutral-300 bg-white [@media(max-height:560px)]:size-9 [&_svg]:size-6"
          animate={{
            backgroundColor: done ? "#303030" : "#ffffff",
            color: done ? "#ffffff" : "#303030",
          }}
        >
          {done ? (
            <Check size={28} />
          ) : failed ? (
            <AlertCircle size={28} />
          ) : (
            <Target
              size={28}
              strokeWidth={1.4}
            />
          )}
        </m.span>
      </div>
      <h2 className="mb-2 text-[clamp(18px,3dvh,26px)] font-normal tracking-tight">{LABELS[status][0]}</h2>
      <p className="m-0 max-w-xl text-xs leading-relaxed wrap-anywhere text-neutral-500">{error || LABELS[status][1]}</p>
      <span className="mt-3 text-xs">{amount} {token}</span>
      {done ? (
        <div className="mt-4 flex items-center gap-5 text-[11px] [&_a]:flex [&_a]:items-center [&_a]:gap-1 [&_button]:rounded-md [&_button]:bg-[#303030] [&_button]:px-4 [&_button]:py-2 [&_button]:text-white">
          {explorerUrl && (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noreferrer"
            >
              View transaction <ArrowUpRight size={16} />
            </a>
          )}
          <button
            type="button"
            onClick={onReset}
          >
            New transaction
          </button>
        </div>
      ) : failed ? (
        <button
          type="button"
          className="mt-3 inline-flex items-center gap-2 bg-transparent py-1 text-[11px]! text-neutral-600"
          onClick={onBack}
        >
          Back to review <ArrowUpRight size={16} />
        </button>
      ) : (
        <span className="mt-3 text-[10px] text-neutral-400">
          Keep this page open while the transaction completes.
        </span>
      )}
    </div>
  );
}
