import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { BaseWalletMultiButton } from "@solana/wallet-adapter-react-ui";
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
import type { Token } from "../components/dashboard/TokenIcon";
import type {
  DashboardOperation,
  PaymentContext,
} from "../components/dashboard/types";
import { formatTokenAmount, SOL_POOL_MINT } from "../lib/payment";
import { SUPPORTED_SPL_MINTS } from "@/hooks/usePaymentTransaction";
import {
  persistDashboardTheme,
  readDashboardTheme,
  transitionDashboardTheme,
  type DashboardTheme,
} from "../components/dashboard/theme";
import { useCharon } from "@/hooks/useCharon";
import { useInfrastructureStatus } from "@/hooks/useInfrastructureStatus";
import "./Dashboard.css";

const WALLET_LABELS = {
  "change-wallet": "Change wallet",
  connecting: "Connecting",
  "copy-address": "Copy address",
  copied: "Copied",
  disconnect: "Disconnect",
  "has-wallet": "Connect wallet",
  "no-wallet": "Connect wallet",
};

const TITLES: Record<DashboardOperation, string> = {
  send: "Send",
  transfer: "Shielded Transfer",
  swap: "Swap",
  payroll: "Payroll",
  withdraw: "Withdraw",
};

export function Dashboard() {
  const [operation, setOperation] = useState<DashboardOperation>("send");
  const [token, setToken] = useState<Token>("SOL");
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<DashboardTheme>(() =>
    typeof document === "undefined" ? "dark" : readDashboardTheme(),
  );
  const lanternRef = useRef<HTMLElement>(null);
  const charon = useCharon(true);
  const infrastructure = useInfrastructureStatus();
  const { connected, signMessage, signTransaction } = useWallet();
  const mint =
    token === "SOL"
      ? SOL_POOL_MINT
      : SUPPORTED_SPL_MINTS[token.toLowerCase() as "usdc" | "usdt"];
  const available = formatTokenAmount(charon.holdings[mint] ?? "0", token);
  const paymentsBlocked =
    infrastructure.ready && infrastructure.tone === "down";
  const context: PaymentContext = {
    ...charon,
    connected,
    token,
    onTokenChange: setToken,
    available,
    paymentsBlocked,
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
            <div className="dashboard-wallet-stack">
              <BaseWalletMultiButton
                labels={WALLET_LABELS}
                disabled={busy}
              />
              <ClientStatus
                connected={connected}
                supported={Boolean(signMessage && signTransaction)}
                initializing={charon.initializingClient}
                error={charon.error}
                onRetry={charon.retry}
              />
              {infrastructure.ready && infrastructure.tone === "degraded" && (
                <p className="dashboard-wallet-note">
                  Indexer is down. A payment may not show up yet.
                </p>
              )}
              {paymentsBlocked && (
                <p className="dashboard-wallet-note">
                  Charon can&apos;t reach the service on this machine.
                </p>
              )}
            </div>
          </header>
          <main className="dashboard-stage">
            <div className="dashboard-column">
              <div className="dashboard-center">
                <HangingLantern
                  theme={theme}
                  onToggle={toggleTheme}
                  lanternRef={lanternRef}
                />
                <p className="dashboard-balance">
                  <span>Private {token}</span>
                  <strong className="dashboard-balance-amount">
                    {available}
                  </strong>
                  <span className="dashboard-balance-unit">{token}</span>
                </p>
                <div className="dashboard-card">
                  <h1 className="dashboard-title">{TITLES[operation]}</h1>
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
              </div>
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
          <StatusLight
            status={infrastructure}
            placement="corner"
          />
        </section>
      </LazyMotion>
    </MotionConfig>
  );
}
