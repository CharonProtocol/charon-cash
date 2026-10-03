"use client";

import { useEffect, useRef, useState } from "react";

import { Lantern } from "@/components/Lantern";
import { isSolanaAddress } from "@/lib/solana";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The waitlist panel. `[data-join]` links scroll here and focus the email field; without JS they fall back to `#list`. */
export function WaitlistForm() {
  const panel = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [wallet, setWallet] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const go = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest("[data-join]") || !panel.current) return;
      e.preventDefault();
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.current.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
      emailRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("click", go);
    return () => document.removeEventListener("click", go);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const address = wallet.trim();
    if (!consent) {
      setStatus("error");
      setMessage("Consent is required.");
      return;
    }
    if (address && !isSolanaAddress(address)) {
      setStatus("error");
      setMessage("That is not a Solana address. Leave it blank if you like.");
      return;
    }
    setStatus("sending");
    setMessage("");
    const params = new URLSearchParams(window.location.search);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          wallet: address || null,
          consent,
          utm_source: params.get("utm_source"),
          utm_medium: params.get("utm_medium"),
          utm_campaign: params.get("utm_campaign"),
          referrer: document.referrer || null,
        }),
      });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) {
        setStatus("error");
        setMessage(data.error || "The crossing did not take.");
        return;
      }
      setStatus("done");
      setMessage(data.message || "You're on the list.");
    } catch {
      setStatus("error");
      setMessage("The crossing did not take.");
    }
  }

  const busy = status === "sending";
  const done = status === "done";
  const emailOk = EMAIL.test(email.trim());

  return (
    <div className="list-cta" ref={panel}>
      <div className="list-cta-head">
        <Lantern lit={done} className="list-lamp" />
        <div>
          <strong>{done ? message : "The early list"}</strong>
          <span>{done ? "We will write when the crossing opens." : "One note when Charon opens."}</span>
        </div>
      </div>

      {!done && (
        <form className="waitlist" onSubmit={onSubmit} noValidate>
          <label className="field">
            <span>
              Email
              <b className="req" aria-hidden="true">
                *
              </b>
            </span>
            <input
              ref={emailRef}
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>

          <label className="field">
            <span>
              Solana wallet <em>optional</em>
            </span>
            <input
              name="wallet"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Public address"
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              disabled={busy}
            />
            <small>Only used to allowlist early access. Leave it blank if you would rather not link the two.</small>
          </label>

          <label className="consent">
            <input
              name="consent"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={busy}
            />
            <span>I agree to hear from Charon Protocol about launch.</span>
          </label>

          <button type="submit" className="btn btn-lamp" disabled={busy || !emailOk}>
            {busy ? "Sending" : "Join the list"}
            <span className="btn-arrow" aria-hidden="true">
              →
            </span>
          </button>
          <p className={status === "error" ? "note error" : "note"} role="status">
            {message}
          </p>
        </form>
      )}
    </div>
  );
}
