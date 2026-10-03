import { TREE } from "@/lib/commitments";

const W = 640;
const H = 540;
const TOP = 60;
const BOTTOM = 480;

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

function nodes() {
  const depth = TREE.length - 1;
  return TREE.map((level, d) => {
    const y = BOTTOM - ((BOTTOM - TOP) * d) / depth;
    const step = W / level.length;
    return level.map((hash, i) => ({ x: step * (i + 0.5), y, hash }));
  });
}

const LEVELS = nodes();
const ROOT = LEVELS.length - 1;

/** A small Poseidon Merkle tree, leaves to root, drawn faintly behind the hero mark. */
export function MerkleArt() {
  return (
    <svg className="merkle" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {LEVELS.slice(1).map((level, d) =>
        level.map((p, i) => {
          const mid = (p.y + LEVELS[d][0].y) / 2;
          return [LEVELS[d][i * 2], LEVELS[d][i * 2 + 1]].map((c, k) => (
            <path key={`e${d}-${i}-${k}`} className="merkle-edge" d={`M${p.x} ${p.y} V${mid} H${c.x} V${c.y}`} />
          ));
        }),
      )}
      {LEVELS.map((level, d) =>
        level.map((p, i) => (
          <g key={`n${d}-${i}`} className={d === ROOT ? "merkle-node root" : "merkle-node"}>
            <circle cx={p.x} cy={p.y} r={d === ROOT ? 4.5 : 2.8} />
            {d === 0 ? (
              <text x={p.x} y={p.y + 20} textAnchor="middle">
                {short(p.hash)}
              </text>
            ) : (
              <text x={p.x + 9} y={p.y - 6}>
                {short(p.hash)}
              </text>
            )}
          </g>
        )),
      )}
      <text x={LEVELS[ROOT][0].x} y={TOP - 18} textAnchor="middle" className="merkle-label">
        root
      </text>
    </svg>
  );
}
