import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  MotionConfig,
  LazyMotion,
  domMax,
  AnimatePresence,
  m,
} from "motion/react";
import { OperationDock } from "../components/dashboard/OperationDock";
import { Send } from "../components/dashboard/operations/Send";
import { ShieldedTransfer } from "../components/dashboard/operations/ShieldedTransfer";
import { Withdraw } from "../components/dashboard/operations/Withdraw";
import { Payroll } from "../components/dashboard/operations/Payroll";
import { Swap } from "../components/dashboard/operations/Swap";
import type {
  DashboardOperation,
  PaymentContext,
} from "../components/dashboard/types";
import { useCharon } from "@/hooks/useCharon";

export function Dashboard() {
  const [operation, setOperation] = useState<DashboardOperation>("send");
  const [busy, setBusy] = useState(false);
  const charon = useCharon(true);
  const { connected } = useWallet();
  const context: PaymentContext = {
    ...charon,
    connected,
    onBusyChange: setBusy,
  };
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion
        features={domMax}
        strict
      >
        <section className="bg-none relative min-h-[480px] h-dvh flex flex-col px-4">
          <header className="shrink-0 flex justify-between px-0 sm:px-20 py-1 text-black items-center">
            <a
              href="#"
              aria-label="Charon home"
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
              className="text-black p-0 text-xl flex items-center"
            >
              <img
                src="./LogoOn.png"
                alt=""
                className="size-14"
              />
              <p className="">CHARON</p>
            </a>
            <div
              className={busy ? "opacity-50" : ""}
              inert={busy || undefined}
            >
              <WalletMultiButton />
            </div>
          </header>
          <main className="grow flex relative min-h-0  justify-center pt-10 pb-20">
            <div className="flex min-h-0 w-full max-w-3xl flex-col">
              <AnimatePresence
                mode="wait"
                initial={false}
              >
                <m.section
                  key={`${operation}-${charon.address ?? "disconnected"}`}
                  id="pay-panel"
                  className="flex min-h-0 flex-1 flex-col"
                  role="tabpanel"
                  aria-labelledby={`pay-tab-${operation}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                >
                  {operation === "send" && <Send context={context} />}
                  {operation === "withdraw" && <Withdraw context={context} />}
                  {operation === "swap" && <Swap />}
                  {operation === "payroll" && <Payroll />}
                  {operation === "transfer" && (
                    <ShieldedTransfer context={context} />
                  )}
                </m.section>
              </AnimatePresence>
            </div>
            <div className="absolute inset-x-0 bottom-10 flex justify-center">
              <OperationDock
                value={operation}
                busy={busy}
                onChange={(next) => {
                  if (!busy && next !== "swap" && next !== "payroll")
                    setOperation(next);
                }}
              />
            </div>
          </main>
        </section>
      </LazyMotion>
    </MotionConfig>
  );
}
