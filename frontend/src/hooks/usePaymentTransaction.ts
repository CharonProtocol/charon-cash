import { useEffect, useRef, useState } from "react";
import { IS_DEVNET, mintForToken, transactionExplorerUrl } from "../lib/config";
import { PublicKey } from "@solana/web3.js";
import {
  describePaymentError,
  isSoftPaymentError,
  parseTokenAmount,
} from "../lib/payment";
import type { Token } from "../components/dashboard/TokenIcon";
import type {
  PaymentContext,
  PaymentKind,
  PaymentStatus,
} from "../components/dashboard/types";

const NOTE_SYNC_MS = 1000;
const NOTE_SYNC_ATTEMPTS = 20;

function pullNotes(context: PaymentContext) {
  const client = context.client;
  if (!client) return;
  client.requestNoteScan();
  void client.syncUtxos().then(() => {
    context.refresh();
  });
}

export function usePaymentTransaction(
  kind: PaymentKind,
  context: PaymentContext,
) {
  const [status, setStatus] = useState<PaymentStatus>("idle");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const running = useRef(false);
  const mounted = useRef(true);
  const noteSync = useRef<number | null>(null);
  const stopNoteSync = () => {
    if (noteSync.current !== null) {
      window.clearInterval(noteSync.current);
      noteSync.current = null;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopNoteSync();
    };
  }, []);
  const submit = async (
    amount: string,
    recipient: string,
    token: Token,
    outToken?: Token,
  ) => {
    if (!context.client || running.current) return;
    running.current = true;
    context.onBusyChange(true);
    setError("");
    setStatus("proof");
    try {
      const lamports = parseTokenAmount(amount, token);
      const destination =
        kind === "withdraw" || kind === "swap"
          ? ""
          : new PublicKey(recipient.trim()).toBase58();
      const onProgress = (next: "proof" | "signing" | "confirming") => {
        if (mounted.current) setStatus(next);
      };
      context.observeProgress(onProgress);

      if (kind === "swap") {
        if (IS_DEVNET) throw new Error("Jupiter swaps are unavailable on devnet.");
        if (!outToken || outToken === token) {
          throw new Error("Choose a different output asset.");
        }
        if (token !== "SOL" && outToken !== "SOL") {
          throw new Error("Swap SOL with USDC or USDT.");
        }
      }

      const result =
        kind === "swap"
          ? await context.client.swap(mintForToken(token), mintForToken(outToken!), lamports)
          : kind === "send"
          ? token === "SOL"
            ? await context.client.sendSol(lamports, destination)
            : await context.client.sendSpl(
                lamports,
                destination,
                mintForToken(token),
              )
          : kind === "withdraw"
            ? token === "SOL"
              ? await context.client.withdrawSol(lamports)
              : await context.client.withdrawSpl(
                  lamports,
                  mintForToken(token),
                )
            : token === "SOL"
              ? await context.client.shieldedTransferSol(lamports, recipient)
              : await context.client.shieldedTransferSpl(
                  lamports,
                  mintForToken(token),
                  recipient,
                );
      if (mounted.current) {
        setSignature(result.signature);
        setStatus("success");
      }
      context.refresh();
      pullNotes(context);
      stopNoteSync();
      let ticks = 0;
      noteSync.current = window.setInterval(() => {
        ticks += 1;
        pullNotes(context);
        if (ticks >= NOTE_SYNC_ATTEMPTS) stopNoteSync();
      }, NOTE_SYNC_MS);
    } catch (cause) {
      const raw =
        cause instanceof Error
          ? cause.message
          : "Unable to complete the transaction.";
      if (mounted.current && isSoftPaymentError(raw)) {
        setStatus("idle");
        return { formError: describePaymentError(raw) };
      }
      if (mounted.current) {
        console.log("Error is ,", cause);
        setError(describePaymentError(raw));
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
  return {
    status,
    error,
    submit,
    reset,
    explorerUrl: signature
      ? transactionExplorerUrl(signature)
      : undefined,
  };
}
