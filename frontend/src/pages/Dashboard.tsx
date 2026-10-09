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
import "./Dashboard.css";

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
        <section className="dashboard-page">
          <header className="dashboard-navbar">
            <a
              href="#"
              aria-label="Charon home"
              onClick={(event) => {
                if (busy) event.preventDefault();
              }}
              className="dashboard-brand"
            >
              <img
                src="./LogoOn.png"
                alt=""
                className="dashboard-brand-mark"
              />
              <span>CHARON</span>
            </a>
            <div
              className={busy ? "opacity-50" : ""}
              inert={busy || undefined}
            >
              <WalletMultiButton />
            </div>
          </header>
          <main className="dashboard-stage">
            <div className="dashboard-panel">
              <AnimatePresence
                mode="wait"
                initial={false}
              >
                <m.section
                  key={`${operation}-${charon.address ?? "disconnected"}`}
                  id="pay-panel"
                  className="dashboard-operation"
                  role="tabpanel"
                  aria-labelledby={`pay-tab-${operation}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                >
                  {operation === "send" && <Send context={context} />}
                  {operation === "withdraw" && <Withdraw context={context} />}
                  {operation === "swap" && <Swap context={context} />}
                  {operation === "payroll" && <Payroll />}
                  {operation === "transfer" && (
                    <ShieldedTransfer context={context} />
                  )}
                </m.section>
              </AnimatePresence>
              <div className="dashboard-dock-wrap">
                <OperationDock
                  value={operation}
                  busy={busy}
                  onChange={(next) => {
                    if (!busy && next !== "payroll" && next !== "swap")
                      setOperation(next);
                  }}
                />
              </div>
            </div>
          </main>
        </section>
      </LazyMotion>
    </MotionConfig>
  );
}
