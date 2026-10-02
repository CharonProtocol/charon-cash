import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  MotionConfig,
  LazyMotion,
  domMax,
  AnimatePresence,
  m,
} from "motion/react";
import { useCharon } from "../hooks/useCharon";
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

const OPERATIONS = {
  send: { title: "Send", direction: "wallet to private", component: Send },
  transfer: {
    title: "Shielded Transfer",
    direction: "private to private",
    component: ShieldedTransfer,
  },
  withdraw: {
    title: "Withdraw",
    direction: "private to wallet",
    component: Withdraw,
  },
  payroll: {
    title: "Payroll",
    direction: "private payments in batches",
    component: Payroll,
  },
  swap: { title: "Swap", direction: "private asset exchange", component: Swap },
};
export function Dashboard() {
  const [operation, setOperation] = useState<DashboardOperation>("send");
  const [busy, setBusy] = useState(false);
  const account = useCharon();
  const { connected } = useWallet();
  const { connection } = useConnection();
  const current = OPERATIONS[operation];
  const Component = current.component;
  const context: PaymentContext = {
    ...account,
    connected,
    onBusyChange: setBusy,
    rpcUrl: connection.rpcEndpoint,
  };
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion
        features={domMax}
        strict
      >
        <div className="grid h-dvh grid-rows-[clamp(48px,9dvh,72px)_minmax(0,1fr)] overflow-clip bg-white font-mono text-[#111] scheme-light [&_button]:border-0 [&_.wallet-adapter-button]:h-[38px]! [&_.wallet-adapter-button]:rounded-md! [&_.wallet-adapter-button]:bg-[#303030]! [&_.wallet-adapter-button]:px-4 [&_.wallet-adapter-button]:font-mono! [&_.wallet-adapter-button]:text-xs! [&_.wallet-adapter-button]:font-normal! [&_.wallet-adapter-button]:text-white! [@media(max-height:560px)]:[&_.wallet-adapter-button]:h-[30px]!">
          <header className="flex min-h-0 items-center justify-between border-b border-neutral-200 px-5 sm:px-[clamp(24px,7vw,100px)] [&>a]:text-[clamp(21px,3dvh,27px)] [&>a]:tracking-tight">
            <a
              href="#"
              aria-label="Charon home"
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
            >
              CHARON
            </a>
            <div
              className={busy ? "opacity-50" : ""}
              inert={busy || undefined}
            >
              <WalletMultiButton />
            </div>
          </header>
          <main className="mx-auto grid h-full min-h-0 w-full max-w-[980px] grid-rows-[auto_minmax(0,1fr)_auto] gap-[clamp(8px,2dvh,18px)] px-5 pt-[clamp(10px,3dvh,28px)] pb-[clamp(10px,2dvh,20px)] sm:px-7 [@media(max-height:560px)]:gap-2 [@media(max-height:560px)]:py-2">
            <div className="min-w-0">
              <h1 className="m-0 text-[clamp(24px,4dvh,36px)] leading-tight font-normal tracking-[-2px]">
                {current.title}
              </h1>
              <p className="mt-1 ml-6 text-[11px]">{current.direction}</p>
            </div>
            <AnimatePresence
              mode="wait"
              initial={false}
            >
              <m.section
                key={operation}
                id="pay-panel"
                className="min-h-0 min-w-0"
                role="tabpanel"
                aria-labelledby={`pay-tab-${operation}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
              >
                <Component
                  key={`${operation}-${account.address ?? "disconnected"}`}
                  context={context}
                />
              </m.section>
            </AnimatePresence>
            <OperationDock
              value={operation}
              busy={busy}
              onChange={(next) => {
                if (!busy && next !== "swap" && next !== "payroll")
                  setOperation(next);
              }}
            />
          </main>
        </div>
      </LazyMotion>
    </MotionConfig>
  );
}
