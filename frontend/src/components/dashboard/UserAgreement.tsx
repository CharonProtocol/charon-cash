import { useEffect, useRef, useState } from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export function UserAgreement({
  connected,
  onAgree,
}: {
  connected: boolean;
  onAgree: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.querySelector<HTMLInputElement>("input")?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        document.querySelector(".wallet-adapter-modal")
      )
        return;
      const controls = element?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input, a[href]",
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => document.removeEventListener("keydown", trapFocus);
  }, []);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-5">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agreement-title"
        className="w-[min(92vw,440px)] rounded-xl bg-white p-6 font-mono text-[#111]"
      >
        <h2
          id="agreement-title"
          className="text-xl"
        >
          User agreement
        </h2>
        <p className="mt-4 text-xs leading-relaxed">
          To use Charon, you agree to review and approve your wallet requests
          and transactions. You are responsible for your wallet, recovery
          information, and payment details. Blockchain transactions are
          irreversible.
        </p>
        <p className="mt-3 text-xs leading-relaxed">
          Continuing creates your private client using a wallet signature.
        </p>
        <label className="mt-5 flex items-start gap-3 text-xs">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          I have read and agree to the user agreement.
        </label>
        <div className="mt-5 flex items-center justify-end gap-3">
          {!connected && <WalletMultiButton />}
          <button
            type="button"
            disabled={!agreed || !connected}
            onClick={onAgree}
            className="rounded-md bg-[#303030] px-4 py-2 text-xs text-white disabled:opacity-40"
          >
            Agree and continue
          </button>
        </div>
      </div>
    </div>
  );
}
