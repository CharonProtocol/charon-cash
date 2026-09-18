import { ArrowLeftRight, ArrowRight, Lock, Server, ShieldCheck, Zap } from "lucide-react"
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
      <g className="stroke-border" strokeWidth={1.5} fill="none">
        <path d="M210 36 L105 112 M210 36 L315 112" />
        <path d="M105 112 L52 188 M105 112 L158 188 M315 112 L262 188 M315 112 L368 188" />
        <path d="M52 188 L26 264 M52 188 L78 264 M158 188 L130 264 M158 188 L186 264 M262 188 L238 264 M262 188 L288 264 M368 188 L342 264 M368 188 L394 264" />
      </g>
      <g className="stroke-primary" strokeWidth={2.2} fill="none">
        <path d="M130 264 L158 188 M158 188 L105 112 M105 112 L210 36" />
      </g>
      <g className="fill-muted-foreground/40">
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
      <g className="fill-primary">
        <circle cx={210} cy={36} r={6} />
        <circle cx={105} cy={112} r={5.5} />
        <circle cx={158} cy={188} r={5.5} />
        <circle cx={130} cy={264} r={6.5} />
      </g>
      <g
        fontFamily="'IBM Plex Mono', monospace"
        fontSize={9}
        className="fill-muted-foreground"
      >
        <text x={222} y={32}>
          root
        </text>
        <text x={140} y={280} className="fill-primary">
          your commitment
        </text>
      </g>
    </svg>
  )
}

const STATS = [
  { k: "Tree", v: "26 levels", s: "Poseidon Merkle" },
  { k: "Proof", v: "Groth16", s: "BN254, hosted prove" },
  { k: "Withdraw", v: "Relayer-signed", s: "no browser RPC submit" },
  { k: "Swap", v: "Atomic v1", s: "shielded SOL ↔ SPL" },
]

const FEATURES = [
  {
    icon: Lock,
    title: "100% client-side ZK",
    body: "Your spending key, blinding factor, and the Groth16 witness are generated entirely in your browser. No secret ever leaves your device.",
    tag: "Poseidon + WebAssembly",
  },
  {
    icon: Zap,
    title: "Wallet-signed withdrawals",
    body: "You prove ownership, then your wallet signs the withdraw. The pool pays the recipient and the protocol fee. The relayer is only used for v1 swaps (wallets cannot sign those yet).",
    tag: "Wallet-signed",
  },
  {
    icon: ShieldCheck,
    title: "Double-spend proof",
    body: "Nullifiers are written on-chain as PDAs. Once a note is spent it can never be reused — cryptographically enforced.",
    tag: "On-chain nullifier set",
  },
  {
    icon: ArrowLeftRight,
    title: "Atomic private swap",
    body: "Swap shielded SOL for USDC (or back) in one v1 instruction: two JoinSplits plus Jupiter. Funds never unshield to a public wallet. The relayer signs — Phantom cannot sign v1 yet.",
    tag: "Jupiter CPI · relayer-signed",
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
    body: "Prove ownership, then your wallet signs the withdraw. The pool pays a brand-new address with no link back to the deposit.",
  },
  {
    n: "4",
    title: "Or swap without unshielding",
    body: "Spend a private note, Jupiter-swap inside the pool, and receive a new note of the other asset in one relayer-signed v1 transaction.",
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
            Deposit SOL or SPL tokens, hold a secret note, withdraw to a fresh
            address, or swap privately without unshielding. Deposits, transfers, and
            withdraws are wallet-signed. Only v1 swaps are relayer-signed — Phantom
            cannot sign those packets yet.
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
            Deposit with your wallet. Withdraw and transfer with a client-side proof
            plus a wallet signature. Swaps are relayer-signed because they are v1.
            Secrets never leave the browser.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          {FEATURES.map((f) => {
            const Icon = f.icon
            return (
              <div
                key={f.title}
                className="space-y-4 rounded-[14px] border border-border bg-card p-6 transition-colors hover:border-primary/40"
              >
                <div className="flex size-11 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
                  <Icon className="size-5" />
                </div>
                <h3 className="h-display text-lg text-foreground">{f.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                <p className="font-mono text-[11px] text-primary">{f.tag}</p>
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
              Shield, prove, withdraw — or swap without leaving the pool.
            </p>
          </div>
          <Button onClick={() => onNavigate("app")}>Open the app</Button>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
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
