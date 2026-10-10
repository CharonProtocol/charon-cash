import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Moon, Sun } from "lucide-react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { MotionConfig, LazyMotion, domMax } from "motion/react";
import { OperationDock } from "../components/dashboard/OperationDock";
import { ClientStatus } from "../components/dashboard/ClientStatus";
import { HangingLantern } from "../components/dashboard/HangingLantern";
import { StatusLight } from "../components/dashboard/StatusLight";
import { Send } from "../components/dashboard/operations/Send";
import { ShieldedTransfer } from "../components/dashboard/operations/ShieldedTransfer";
import { Withdraw } from "../components/dashboard/operations/Withdraw";
import { Payroll } from "../components/dashboard/operations/Payroll";
import { Swap } from "../components/dashboard/operations/Swap";
import type {
  DashboardOperation,
  PaymentContext,
} from "../components/dashboard/types";
import {
  persistDashboardTheme,
  readDashboardTheme,
  transitionDashboardTheme,
  type DashboardTheme,
} from "../components/dashboard/theme";
import { useCharon } from "@/hooks/useCharon";
import { useInfrastructureStatus } from "@/hooks/useInfrastructureStatus";
import "./Dashboard.css";

const TITLES: Record<DashboardOperation, string> = {
  send: "Send",
  transfer: "Shielded Transfer",
  swap: "Swap",
  payroll: "Payroll",
  withdraw: "Withdraw",
};

export function Dashboard() {
  const [operation, setOperation] = useState<DashboardOperation>("send");
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<DashboardTheme>(() =>
    typeof document === "undefined" ? "dark" : readDashboardTheme(),
  );
  const lanternRef = useRef<HTMLElement>(null);
  const charon = useCharon(true);
  const infrastructure = useInfrastructureStatus();
  const { connected, signMessage, signTransaction } = useWallet();
  const context: PaymentContext = {
    ...charon,
    connected,
    onBusyChange: setBusy,
  };

  useEffect(() => {
    persistDashboardTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    const next: DashboardTheme = theme === "dark" ? "light" : "dark";
    const node = lanternRef.current;
    const box = node?.getBoundingClientRect();
    const origin = box
      ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight * 0.22 };
    void transitionDashboardTheme(() => {
      flushSync(() => setTheme(next));
      persistDashboardTheme(next);
    }, origin);
  }, [theme]);

  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion
        features={domMax}
        strict
      >
        <section
          className="dashboard-page"
          data-theme={theme}
        >
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
                src={theme === "dark" ? "./LogoOn.png" : "./LogoOff.png"}
                alt=""
                className="dashboard-brand-mark"
              />
              <span>CHARON</span>
            </a>
            <div className="dashboard-nav-actions">
              <StatusLight
                status={infrastructure}
                placement="nav"
              />
              <span className="dashboard-local">Local</span>
              <button
                type="button"
                className="dashboard-theme-toggle"
                onClick={toggleTheme}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              >
                {theme === "dark" ? (
                  <Sun
                    size={18}
                    strokeWidth={1.6}
                  />
                ) : (
                  <Moon
                    size={18}
                    strokeWidth={1.6}
                  />
                )}
              </button>
              <div
                className={`dashboard-wallet${busy ? " is-busy" : ""}`}
                inert={busy || undefined}
              >
                <WalletMultiButton />
              </div>
            </div>
          </header>
          <main className="dashboard-stage">
            <HangingLantern
              theme={theme}
              onToggle={toggleTheme}
              lanternRef={lanternRef}
            />
            <div className="dashboard-card">
              <h1 className="dashboard-title">{TITLES[operation]}</h1>
              <ClientStatus
                connected={connected}
                supported={Boolean(signMessage && signTransaction)}
                initializing={charon.initializingClient}
                error={charon.error}
                onRetry={charon.retry}
              />
              <section
                key={`${operation}-${charon.address ?? "disconnected"}`}
                id="pay-panel"
                className="dashboard-operation"
                role="tabpanel"
                aria-labelledby={`pay-tab-${operation}`}
              >
                {operation === "send" && <Send context={context} />}
                {operation === "withdraw" && <Withdraw context={context} />}
                {operation === "swap" && <Swap context={context} />}
                {operation === "payroll" && <Payroll />}
                {operation === "transfer" && (
                  <ShieldedTransfer context={context} />
                )}
              </section>
            </div>
            <div className="dashboard-dock-wrap">
              <StatusLight
                status={infrastructure}
                placement="dock"
              />
              <OperationDock
                value={operation}
                busy={busy}
                onChange={(next) => {
                  if (!busy && next !== "payroll" && next !== "swap")
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
