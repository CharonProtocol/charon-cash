import {
  ArrowUpRight,
  ArrowLeftRight,
  DollarSign,
  BanknoteArrowDown,
} from "lucide-react";
import { m } from "motion/react";
import { ShieldIcon } from "./ShieldIcon";
import type { DashboardOperation } from "./types";
import { IS_DEVNET } from "../../lib/config";

const ITEMS = [
  { id: "send", label: "Send", short: "Send", icon: ArrowUpRight },
  {
    id: "transfer",
    label: "Shielded Transfer",
    short: "Shield",
    icon: ShieldIcon,
  },
  { id: "swap", label: "Swap", short: "Swap", icon: ArrowLeftRight, disabled: true },
  { id: "payroll", label: "Payroll", short: "Payroll", icon: DollarSign, disabled: true },
  {
    id: "withdraw",
    label: "Withdraw",
    short: "Withdraw",
    icon: BanknoteArrowDown,
  },
] as const;

export function OperationDock({
  value,
  busy,
  onChange,
}: {
  value: DashboardOperation;
  busy: boolean;
  onChange: (value: DashboardOperation) => void;
}) {
  const select = (id: DashboardOperation) => {
    onChange(id);
  };
  return (
    <nav
      className="dashboard-operation-dock"
      aria-label="Payment operations"
    >
      <div
        role="tablist"
        aria-label="Payment operation"
        className="dashboard-operation-tabs"
      >
        {ITEMS.map((item) => {
          const unavailable = "disabled" in item && item.disabled;
          return (
            <button
              type="button"
              role="tab"
              id={`pay-tab-${item.id}`}
              aria-selected={value === item.id}
              aria-controls="pay-panel"
              disabled={busy || unavailable}
              aria-label={item.label}
              title={item.id === "swap" && IS_DEVNET
                ? "Jupiter swaps are unavailable on devnet"
                : unavailable ? `${item.label} is coming soon` : undefined}
              key={item.id}
              onClick={() => select(item.id)}
              onKeyDown={(event) => {
                if (
                  !["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                    event.key,
                  ) ||
                  busy
                )
                  return;
                event.preventDefault();
                const enabled = ITEMS.filter(
                  (candidate) => !("disabled" in candidate),
                );
                const index = enabled.findIndex(
                  (candidate) => candidate.id === value,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? enabled.length - 1
                      : (index +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          enabled.length) %
                        enabled.length;
                select(enabled[next].id);
                document.getElementById(`pay-tab-${enabled[next].id}`)?.focus();
              }}
              tabIndex={value === item.id ? 0 : -1}
              className="dashboard-operation-tab"
            >
              {value === item.id && (
                <m.span
                  className="dashboard-operation-pill"
                  layoutId="operation-pill"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <item.icon
                className="dashboard-operation-icon"
                strokeWidth={1.5}
              />
              <span>{item.short}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
