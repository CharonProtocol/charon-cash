import type { InfrastructureSnapshot, ProbeState } from "../../lib/infrastructure";

const TONE_LABEL = {
  up: "All systems up",
  degraded: "Some systems degraded",
  down: "Backend unreachable",
} as const;

const PROBES: { key: "backend" | "yellowstone" | "rpc"; label: string }[] = [
  { key: "backend", label: "Backend" },
  { key: "yellowstone", label: "Yellowstone" },
  { key: "rpc", label: "RPC" },
];

function probeLabel(state: ProbeState) {
  return state === "up" ? "up" : "down";
}

export function StatusLight({
  status,
  placement,
}: {
  status: InfrastructureSnapshot;
  placement: "dock" | "nav" | "corner";
}) {
  const tone = status.ready ? status.tone : "checking";
  const summary = status.ready
    ? TONE_LABEL[status.tone]
    : "Checking infrastructure";
  const legendId = `infra-legend-${placement}`;

  return (
    <div
      className={`dashboard-status-light dashboard-status-light--${placement}`}
    >
      <button
        type="button"
        className="dashboard-status-light-hit"
        aria-label={summary}
        aria-describedby={legendId}
      >
        <span
          className={`dashboard-status-light-dot dashboard-status-light-dot--${tone}`}
          aria-hidden="true"
        />
      </button>
      <div
        id={legendId}
        role="tooltip"
        className="dashboard-status-light-legend"
      >
        <p>{summary}</p>
        <ul>
          {PROBES.map((probe) => (
            <li key={probe.key}>
              <span
                className={`dashboard-status-light-mark dashboard-status-light-mark--${status.ready ? status[probe.key] : "down"}`}
                aria-hidden="true"
              />
              {probe.label}
              <span className="dashboard-status-light-state">
                {" "}
                {status.ready ? probeLabel(status[probe.key]) : "…"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
