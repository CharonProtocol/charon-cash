import { COMMITMENTS } from "@/lib/commitments";

const ROWS = 26;
const PER_ROW = 5;

function row(i: number) {
  const start = (i * 7) % COMMITMENTS.length;
  const items = Array.from({ length: PER_ROW }, (_, k) => COMMITMENTS[(start + k) % COMMITMENTS.length]);
  return items.join("   ");
}

const LINES = Array.from({ length: ROWS }, (_, i) => row(i));

function Layer({ className }: { className: string }) {
  return (
    <div className={className}>
      {LINES.map((line, i) => (
        <div key={i} className={i % 2 ? "hash-row rev" : "hash-row"} style={{ "--t": `${150 + (i % 5) * 24}s` } as React.CSSProperties}>
          <span>{line}</span>
          <span>{line}</span>
        </div>
      ))}
    </div>
  );
}

/** Poseidon note commitments drifting behind the page; a second copy is lit only under the pointer. */
export function HashField() {
  return (
    <div className="hash-field">
      <Layer className="hash-layer hash-base" />
      <Layer className="hash-layer hash-lit" />
    </div>
  );
}
