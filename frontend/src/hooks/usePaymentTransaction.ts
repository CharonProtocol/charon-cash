import { useEffect, useRef, useState } from "react";
import { RPC_URL } from "../lib/config";
import { PublicKey } from "@solana/web3.js";
import { assertPaymentSupported, parseTokenAmount } from "../lib/payment";
import type { Token } from "../components/dashboard/TokenIcon";
import type {
  PaymentContext,
  PaymentKind,
  PaymentStatus,
} from "../components/dashboard/types";

export function usePaymentTransaction(
  kind: PaymentKind,
  context: PaymentContext,
) {
  const [status, setStatus] = useState<PaymentStatus>("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const submit = async (amount: string, recipient: string, token: Token) => {
    if (!context.client || running.current) return;
    running.current = true;
    context.onBusyChange(true);
    setError("");
    setStatus("proof");
    try {
      assertPaymentSupported(kind, token);
      const lamports = parseTokenAmount(amount, token);
      const destination =
        kind === "withdraw" ? "" : new PublicKey(recipient.trim()).toBase58();
      const onProgress = (next: "proof" | "signing" | "confirming") => {
        if (mounted.current) setStatus(next);
      };
      context.observeProgress(onProgress);
      const result =
        kind === "send"
          ? await context.client.sendSol(lamports, destination)
          : kind === "withdraw"
            ? await context.client.withdrawSol(lamports)
            : await context.client.shieldedTransferSol(lamports, recipient);
      if (mounted.current) {
        setSignature(result.signature);
        setStatus("success");
      }
      context.refresh();
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to complete the transaction.",
        );
        setStatus("error");
      }
    } finally {
      context.observeProgress(null);
      running.current = false;
      context.onBusyChange(false);
    }
  };
  const reset = () => {
    setStatus("idle");
    setSignature("");
    setError("");
  };
  const query = new URLSearchParams({
    cluster: "custom",
    customUrl: RPC_URL,
  });
  return {
    status,
    error,
    submit,
    reset,
    explorerUrl: signature
      ? `https://explorer.solana.com/tx/${signature}?${query}`
      : undefined,
  };
}
