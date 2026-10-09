import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  ArrowLeftRight,
  DollarSign,
  BanknoteArrowDown,
} from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { ShieldIcon } from "./ShieldIcon";
import type { DashboardOperation } from "./types";
const ITEMS = [
  { id: "send", label: "Send", icon: ArrowUpRight },
  { id: "transfer", label: "Shielded Transfer", icon: ShieldIcon },
  { id: "swap", label: "Swap", icon: ArrowLeftRight, disabled: true },
  { id: "payroll", label: "Payroll", icon: DollarSign, disabled: true },
  { id: "withdraw", label: "Withdraw", icon: BanknoteArrowDown },
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
  const [notice, setNotice] = useState<{
    label: string;
    sequence: number;
  } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const select = (id: DashboardOperation) => {
    onChange(id);
    setNotice((previous) => ({
      label: ITEMS.find((item) => item.id === id)!.label,
      sequence: (previous?.sequence ?? 0) + 1,
    }));
  };
  return (
    <nav
      className="dashboard-operation-dock relative mx-auto w-full max-w-full rounded-full border border-[#dfdcda] bg-linear-to-b from-[#faf9f9] to-white p-1.5 shadow-sm sm:w-fit"
      aria-label="Payment operations"
    >
      <AnimatePresence>
        {notice && (
          <m.div
            key={notice.sequence}
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute bottom-full left-1/2 mb-3 -translate-x-1/2 whitespace-nowrap rounded-lg bg-[#303030] px-3 py-2 text-xs text-white shadow-md sm:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            {notice.label}
          </m.div>
        )}
      </AnimatePresence>
      <div
        role="tablist"
        aria-label="Payment operation"
        className="grid grid-cols-5 items-center gap-1 sm:flex"
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
              title={unavailable ? `${item.label} is coming soon` : undefined}
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
              className={`dashboard-operation-tab relative isolate flex min-h-10 items-center justify-center gap-2 rounded-full bg-transparent px-3 py-2 text-xs! whitespace-nowrap focus-visible:outline-offset-[-3px] disabled:opacity-30 sm:px-3.5 sm:text-sm! ${value === item.id ? "text-white" : "text-[#111]"}`}
            >
              {value === item.id && (
                <m.span
                  className="absolute inset-0 -z-10 rounded-full bg-black"
                  layoutId="operation-pill"
                  transition={{ type: "spring", stiffness: 400, damping: 35 }}
                />
              )}
              <item.icon
                className="h-6 w-5 shrink-0"
                size={24}
                strokeWidth={1.5}
              />
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
