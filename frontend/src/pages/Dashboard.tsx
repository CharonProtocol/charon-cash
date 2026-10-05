import { useState } from "react";
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
import type { DashboardOperation } from "../components/dashboard/types";
import { useCharon } from "@/hooks/useCharon";

const OPERATIONS = {
  send: Send,
  transfer: ShieldedTransfer,
  withdraw: Withdraw,
  payroll: Payroll,
  swap: Swap,
};

export function Dashboard() {
  const [operation, setOperation] = useState<DashboardOperation>("send");
  const [busy, setBusy] = useState(false);
  const charon = useCharon(false);

  const Component = OPERATIONS[operation];
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion
        features={domMax}
        strict
      >
        <section className="bg-none relative h-screen flex flex-col">
          <header className="basis-2 flex justify-between px-20 py-1 text-black items-center">
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
          <main className="grow relative">
            <AnimatePresence
              mode="wait"
              initial={false}
            >
              {operation == "send" && <Send></Send>}
              {operation == "withdraw" && <Withdraw></Withdraw>}
              {operation == "swap" && <Swap></Swap>}
              {operation == "payroll" && <Payroll></Payroll>}
              {operation == "transfer" && <ShieldedTransfer></ShieldedTransfer>}
            </AnimatePresence>
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
