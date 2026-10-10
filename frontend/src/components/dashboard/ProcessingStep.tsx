import { m, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check, Wallet, AlertCircle } from "lucide-react";
import { ShieldIcon } from "./ShieldIcon";
import type { Token } from "./TokenIcon";
import type { PaymentKind, PaymentStatus } from "./types";

const LABELS: Record<PaymentStatus, [string, string]> = {
  idle: ["Ready", ""],
  proof: ["Creating proof", "Preparing the transaction in your browser."],
  signing: ["Approve in your wallet", "Sign to continue."],
  confirming: ["Confirming", "Waiting on Solana."],
  success: ["Transaction confirmed", "Payment complete."],
  error: ["Transaction didn’t complete", "You can review and try again."],
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
      className="pay-result"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className="pay-result-track"
        aria-hidden="true"
      >
        <span className="pay-result-icon">
          <Source
            size={22}
            strokeWidth={1.4}
          />
        </span>
        <div className="pay-result-line">
          <m.span
            className="pay-result-dot"
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
        <span
          className={`pay-result-icon${done ? " pay-result-icon--done" : failed ? " pay-result-icon--failed" : ""}`}
        >
          {done ? (
            <Check size={22} />
          ) : failed ? (
            <AlertCircle size={22} />
          ) : (
            <Target
              size={22}
              strokeWidth={1.4}
            />
          )}
        </span>
      </div>
      <h2>{LABELS[status][0]}</h2>
      <p className="pay-result-copy">{error || LABELS[status][1]}</p>
      <span className="pay-result-amount">
        {amount} {token}
      </span>
      {done ? (
        <div className="pay-result-links">
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
            className="pay-result-cta"
            onClick={onReset}
          >
            New transaction
          </button>
        </div>
      ) : failed ? (
        <button
          type="button"
          className="pay-result-cta"
          onClick={onBack}
        >
          Back to review
        </button>
      ) : null}
    </div>
  );
}
