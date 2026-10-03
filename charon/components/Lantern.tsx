export function Lantern({ lit = false, className = "" }: { lit?: boolean; className?: string }) {
  return (
    <svg
      className={`lantern${lit ? " is-lit" : ""}${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.6 5c0-2.6 4.8-2.6 4.8 0" />
      <path d="M8 5h8l-1 2H9z" />
      <rect x="8.5" y="7" width="7" height="10" rx="1.2" />
      <path d="M7.5 17h9l-1 2.5h-7z" />
      <path className="lantern-flame" d="M12 9.4c1.3 1.4 1.7 2.6 1.7 3.5a1.7 1.7 0 0 1-3.4 0c0-.9.5-2 1.7-3.5z" />
    </svg>
  );
}
