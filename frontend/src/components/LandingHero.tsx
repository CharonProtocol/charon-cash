import { ArrowRight, Lock, Server, ShieldCheck, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"

interface LandingHeroProps {
  onNavigate: (route: string) => void
}

/* Poseidon Merkle tree — one leaf and its path to the root highlighted.
   Ported from presentation.html (title slide). */
function MerkleHero() {
  return (
    <svg
      viewBox="0 0 420 300"
      role="img"
      aria-label="A Merkle tree of commitments, with one leaf and its path to the root highlighted"
      className="h-auto w-full max-w-[430px]"
    >
      <g stroke="#e4e7ec" strokeWidth={1.5} fill="none">
        <path d="M210 36 L105 112 M210 36 L315 112" />
        <path d="M105 112 L52 188 M105 112 L158 188 M315 112 L262 188 M315 112 L368 188" />
        <path d="M52 188 L26 264 M52 188 L78 264 M158 188 L130 264 M158 188 L186 264 M262 188 L238 264 M262 188 L288 264 M368 188 L342 264 M368 188 L394 264" />
      </g>
      <g stroke="#5b54e6" strokeWidth={2.2} fill="none">
        <path d="M130 264 L158 188 M158 188 L105 112 M105 112 L210 36" />
      </g>
      <g fill="#d4d8e0">
        <circle cx={315} cy={112} r={4.5} />
        <circle cx={262} cy={188} r={4.5} />
        <circle cx={368} cy={188} r={4.5} />
        <circle cx={52} cy={188} r={4.5} />
        <circle cx={238} cy={264} r={4} />
        <circle cx={288} cy={264} r={4} />
        <circle cx={342} cy={264} r={4} />
        <circle cx={394} cy={264} r={4} />
        <circle cx={26} cy={264} r={4} />
        <circle cx={78} cy={264} r={4} />
        <circle cx={186} cy={264} r={4} />
      </g>
      <g fill="#5b54e6">
        <circle cx={210} cy={36} r={6} />
        <circle cx={105} cy={112} r={5.5} />
        <circle cx={158} cy={188} r={5.5} />
        <circle cx={130} cy={264} r={6.5} />
      </g>
      <g fontFamily="'IBM Plex Mono', monospace" fontSize={9} fill="#868f9e">
        <text x={222} y={32}>
          root
        </text>
        <text x={140} y={280} fill="#5b54e6">
          your commitment
        </text>
      </g>
    </svg>
  )
}

const STATS = [
  { k: "Tree", v: "26 levels", s: "Poseidon Merkle" },
  { k: "Proof", v: "Groth16", s: "BN254, client-side" },
  { k: "Submit", v: "Direct to RPC", s: "self-signed" },
  { k: "Assets", v: "SOL + SPL", s: "any mint" },
]

const FEATURES = [
  {
    icon: Lock,
    swatch: "#5b54e6",
    title: "100% client-side ZK",
    body: "Your spending key, blinding factor, and the Groth16 witness are generated entirely in your browser. No secret ever leaves your device.",
    tag: "Poseidon + WebAssembly",
  },
  {
    icon: Zap,
    swatch: "#0e7c86",
    title: "Direct-to-RPC withdrawals",
    body: "Your wallet signs and submits withdrawals straight to the chain. The pool pays the recipient and the protocol fee — no relayer in the submit path.",
    tag: "Self-signed",
  },
  {
    icon: ShieldCheck,
    swatch: "#111827",
    title: "Double-spend proof",
    body: "Nullifiers are written on-chain as PDAs. Once a note is spent it can never be reused — cryptographically enforced.",
    tag: "On-chain nullifier set",
  },
]

const STEPS = [
  {
    n: "1",
    title: "Shield & deposit",
    body: "Pick SOL or an SPL token. Your browser computes a commitment and registers it on-chain in the Merkle tree.",
  },
  {
    n: "2",
    title: "Generate a ZK proof",
    body: "When you withdraw, prove in-browser that you own a valid leaf — without revealing which one is yours.",
  },
  {
    n: "3",
    title: "Withdraw to a fresh address",
    body: "Your wallet signs and submits direct to RPC. The pool pays a brand-new address with no link back to the deposit.",
  },
]

export function LandingHero({ onNavigate }: LandingHeroProps) {
  return (
    <div className="space-y-16 py-6">
      {/* Hero */}
      <section className="grid items-center gap-10 rounded-[14px] border border-border bg-card px-6 py-10 shadow-sm sm:px-10 md:grid-cols-2 md:px-14">
        <div className="space-y-6">
          <p className="eyebrow !mb-0">A zero-knowledge privacy pool on Solana</p>
          <h1 className="h-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
            Break the on-chain link.
            <br />
            <span className="accent-text">Transact in complete silence.</span>
          </h1>
          <p className="max-w-prose text-lg leading-relaxed text-muted-foreground">
            Deposit SOL or SPL tokens, hold a secret note, and withdraw to a fresh
            address with a client-side ZK proof. Your wallet signs and submits direct
            to the chain — the pool pays the recipient and the fee.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button size="lg" onClick={() => onNavigate("app")} className="px-6">
              Launch App <ArrowRight className="ml-1 size-4" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              onClick={() => onNavigate("explorer")}
            >
              <Server className="mr-2 size-4" /> View Explorer
            </Button>
          </div>
        </div>

        <div className="flex flex-col items-center">
          <MerkleHero />
          <p className="mt-4 max-w-xs text-center font-mono text-[11px] text-muted-foreground">
            A Poseidon Merkle tree of commitments. The proof shows a path to the root
            — without revealing which leaf.
          </p>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-border bg-border md:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.k} className="bg-card p-5">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {s.k}
            </p>
            <p className="h-display mt-1 text-2xl text-foreground">{s.v}</p>
            <p className="text-[11px] text-muted-foreground">{s.s}</p>
          </div>
        ))}
      </section>

      {/* Feature cards */}
      <section className="space-y-6">
        <div className="space-y-2">
          <p className="eyebrow !mb-0">Architecture highlights</p>
          <h2 className="h-display text-3xl text-foreground">Built for privacy and speed</h2>
          <p className="max-w-xl text-sm text-muted-foreground">
            Everything is computed client-side. The pool only verifies pre-built ZK
            proofs on-chain.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon
            return (
              <div
                key={f.title}
                className="space-y-4 rounded-[14px] border border-border bg-card p-6 transition-colors hover:border-[#d4d8e0]"
              >
                <div
                  className="flex size-11 items-center justify-center rounded-xl border"
                  style={{ borderColor: f.swatch, color: f.swatch, background: `${f.swatch}14` }}
                >
                  <Icon className="size-5" />
                </div>
                <h3 className="h-display text-lg text-foreground">{f.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                <p className="font-mono text-[11px]" style={{ color: f.swatch }}>
                  {f.tag}
                </p>
              </div>
            )
          })}
        </div>
      </section>

      {/* 3-step preview */}
      <section className="space-y-6 rounded-[14px] border border-border bg-card p-8">
        <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h2 className="h-display text-2xl text-foreground">How Privacy Cash works</h2>
            <p className="text-sm text-muted-foreground">
              Three steps to anonymize a Solana transaction.
            </p>
          </div>
          <Button onClick={() => onNavigate("app")}>Start a deposit</Button>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {STEPS.map((s) => (
            <div
              key={s.n}
              className="space-y-3 rounded-xl border border-border bg-secondary p-5"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary font-mono text-sm font-semibold text-primary-foreground">
                  {s.n}
                </span>
                <h4 className="font-semibold text-foreground">{s.title}</h4>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
