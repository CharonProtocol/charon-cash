import type { RefObject } from "react";
import type { DashboardTheme } from "./theme";

export function HangingLantern({
  theme,
  onToggle,
  lanternRef,
}: {
  theme: DashboardTheme;
  onToggle: () => void;
  lanternRef: RefObject<HTMLElement | null>;
}) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <div className="dashboard-lantern">
      <button
        type="button"
        className="dashboard-lantern-hit"
        onClick={onToggle}
        aria-label={`Switch to ${next} mode`}
        title={`Switch to ${next} mode`}
      >
        <span className="dashboard-lantern-swing">
          <span className="dashboard-lantern-thread" aria-hidden="true" />
          <img
            ref={lanternRef as RefObject<HTMLImageElement | null>}
            src={theme === "dark" ? "/LanternOn.png" : "/LanternOff.png"}
            alt=""
            draggable={false}
          />
        </span>
      </button>
    </div>
  );
}
