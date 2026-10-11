import { useEffect, useRef, useState } from "react";
import { RPC_URL } from "../lib/config";
import { PublicKey } from "@solana/web3.js";
import {
  describePaymentError,
  isSoftPaymentError,
  parseTokenAmount,
  SOL_POOL_MINT,
} from "../lib/payment";
import type { Token } from "../components/dashboard/TokenIcon";
import type {
  PaymentContext,
  PaymentKind,
  PaymentStatus,
} from "../components/dashboard/types";

export const SUPPORTED_SPL_MINTS = {
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

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

      const mintOf = (asset: Token) =>
        asset === "SOL"
          ? SOL_POOL_MINT
          : SUPPORTED_SPL_MINTS[
              asset.toLowerCase() as keyof typeof SUPPORTED_SPL_MINTS
            ];

      if (kind === "swap") {
        if (!outToken || outToken === token) {
          throw new Error("Choose a different output asset.");
        }
        if (token !== "SOL" && outToken !== "SOL") {
          throw new Error("Swap SOL with USDC or USDT.");
        }
      }

      const result =
        kind === "swap"
          ? await context.client.swap(mintOf(token), mintOf(outToken!), lamports)
          : kind === "send"
          ? token === "SOL"
            ? await context.client.sendSol(lamports, destination)
            : await context.client.sendSpl(
                lamports,
                destination,
                SUPPORTED_SPL_MINTS[
                  token.toLowerCase() as keyof typeof SUPPORTED_SPL_MINTS
                ],
              )
          : kind === "withdraw"
            ? token === "SOL"
              ? await context.client.withdrawSol(lamports)
              : await context.client.withdrawSpl(
                  lamports,
                  SUPPORTED_SPL_MINTS[
                    token.toLowerCase() as keyof typeof SUPPORTED_SPL_MINTS
                  ],
                )
            : token === "SOL"
              ? await context.client.shieldedTransferSol(lamports, recipient)
              : await context.client.shieldedTransferSpl(
                  lamports,
                  SUPPORTED_SPL_MINTS[
                    token.toLowerCase() as keyof typeof SUPPORTED_SPL_MINTS
                  ],
                  recipient,
                  // Note: The SDK currently hardcodes WRAPPED_SOL_MINT for shieldedTransferSpl
                  // but we call it as it is defined.
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
