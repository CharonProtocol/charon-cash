import { Glow } from "@/components/Glow";
import { HashField } from "@/components/HashField";

const COLS = 22;
const ROWS = 14;
const W = 1600;
const H = 1000;

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function facets() {
  const cw = W / COLS;
  const rh = H / ROWS;
  const v = (c: number, r: number) => {
    const edge = c === 0 || c === COLS || r === 0 || r === ROWS;
    const jx = edge ? 0 : (hash(c * 31 + r * 17) - 0.5) * cw * 0.7;
    const jy = edge ? 0 : (hash(c * 7 + r * 53) - 0.5) * rh * 0.7;
    return `${(c * cw + jx).toFixed(1)} ${(r * rh + jy).toFixed(1)}`;
  };
  const out: { d: string; o: string }[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const a = v(c, r);
      const b = v(c + 1, r);
      const d = v(c + 1, r + 1);
      const e = v(c, r + 1);
      out.push({ d: `M${a} L${b} L${d} Z`, o: (0.012 + hash(r * 97 + c) * 0.045).toFixed(3) });
      out.push({ d: `M${a} L${d} L${e} Z`, o: (0.012 + hash(r * 13 + c * 41) * 0.045).toFixed(3) });
    }
  }
  return out;
}

const FIELD = facets();

/** Page-wide faceted water and drifting commitments behind every section, with the pointer lantern on top. */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        {FIELD.map((f, i) => (
          <path key={i} d={f.d} fill="#161616" fillOpacity={f.o} />
        ))}
      </svg>
      <HashField />
      <Glow />
    </div>
  );
}
