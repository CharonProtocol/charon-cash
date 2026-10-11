import { Check, ChevronDown, Code2, Loader2 } from "lucide-react"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CountUp } from "@/components/motion/CountUp"
import { Magnetic } from "@/components/motion/Magnetic"
import { Ms } from "@/components/motion/ms"
import { Scramble } from "@/components/motion/Scramble"
import { Tilt } from "@/components/motion/Tilt"
import { ScrollRuler } from "@/components/motion/ScrollRuler"
import { SmoothScroll, useSmoothScroll } from "@/components/motion/smooth-scroll"
import { ThemeToggle } from "@/components/ThemeToggle"

/* ---------- measured marketing data (all real, logged runs) ---------- */

const bento = [
  {
    icon: "all_inclusive",
    iconCls: "text-gold",
    v: 100,
    unit: "",
    label: "Salaries",
    cls: "text-foreground",
    body: (
      <>
        In about <span className="font-semibold text-gold">80 seconds</span> with{" "}
        <span className="font-semibold text-gold">1 wallet signature</span>. No sequential signing prompts.
      </>
    ),
  },
  {
    icon: "draw",
    iconCls: "text-ok",
    v: 0,
    unit: "",
    label: "Signatures",
    cls: "text-ok",
    body: <>Direct shielded leaf insertion into the Merkle tree.</>,
  },
  {
    icon: "memory",
    iconCls: "text-gold",
    v: 0.8,
    decimals: 1,
    unit: "s",
    label: "Proof Generation",
    cls: "text-foreground",
    body: <>Groth16 built in the employee's browser - the relayer only broadcasts signed transactions.</>,
  },
  {
    icon: "speed",
    iconCls: "text-gold",
    v: 135,
    unit: "k",
    label: "Compute Units",
    cls: "text-foreground",
    body: <>Per packed payout transact. Substantially below Solana's 1.4M ceiling.</>,
  },
  {
    icon: "data_object",
    iconCls: "text-ok",
    v: 1066,
    unit: " B",
    label: "Payload Size",
    cls: "text-foreground",
    body: <>Compact raw payload per settlement, comfortably under the 1,232 B wire cap.</>,
  },
]

const steps = [
  {
    n: "1",
    icon: "account_balance",
    title: "Fund",
    body: "The treasury deposits one lump sum into the shielded pool. Public: the amount in. Hidden: everything after.",
  },
  {
    n: "2",
    icon: "account_tree",
    title: "Split",
    body: "Funds are shielded into pool wallets as merkle-tree commitments - no addresses, no amounts, just hashes.",
  },
  {
    n: "3",
    icon: "bolt",
    title: "Pay",
    body: "Every salary leaves with its own zero-knowledge proof, built on the employee's device. 100 people in ~80 seconds, 0 failures.",
  },
  {
    n: "4",
    icon: "task_alt",
    title: "Claim",
    body: "Employees hold private notes in their wallet and claim to plain SOL whenever they want - gasless.",
  },
]

const capabilities = [
  "CSV / JSON upload with row validation",
  "Plan review with exact fees before signing",
  "Public or fully shielded mode per run",
  "Live per-row progress and receipts",
  "One-click resume of failed rows",
  "One wallet signature per run - zero when the vault is funded",
  "Gasless claims - employees need zero SOL",
  "Notes encrypted to published recipient keys",
  "Token-agnostic v2 note format",
  "Relayer mirror sync - no chain scan for users",
]

const runtimeBars = [
  { label: "before optimization", v: "10 min", w: "100%", cls: "bg-zinc-300 dark:bg-zinc-700" },
  { label: "today - proofs on device", v: "~80s", w: "13%", cls: "bg-gold" },
]

const pipeline = [
  { n: "zk proof", v: "0.8s", d: "one Groth16 proof, built on the employee's device" },
  { n: "relayer", v: "no keys", d: "broadcasts your signed transaction - builds nothing, holds nothing" },
  { n: "confirm", v: "400-500ms", d: "from submit to reflecting on your device" },
]

const SDK_SNIPPET = `import { PrivacyCashClient, publishRecipientKeys } from "privacy-cash-sdk"

// employees publish receiving keys once - notes are encrypted to them
await publishRecipientKeys({ publicKey, signMessage, signTransaction })

const client = new PrivacyCashClient(signer)
await client.init()   // load the shielded pool view
await client.unlock() // decrypt your notes locally

// claim a private note to your wallet - gasless, relayed
const r = await client.withdrawSOL(amountLamports, recipient, { relay: true })`

/** Tiny tokenizing highlighter for the SDK snippet — comments, strings,
 *  keywords, SDK types, numbers; colors come from theme tokens. */
function CodeBlock({ code }: { code: string }) {
  const re =
    /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(import|from|const|await|async|new|return|export)\b|\b(PrivacyCashClient|publishRecipientKeys|Boolean|Number|String)\b|\b(\d+(?:\.\d+)?)\b/g
  const nodes: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) nodes.push(code.slice(last, m.index))
    const cls = m[1]
      ? "tok-com"
      : m[2]
        ? "tok-str"
        : m[3]
          ? "tok-kw"
          : m[4]
            ? "tok-type"
            : "tok-num"
    nodes.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < code.length) nodes.push(code.slice(last))
  return (
    <pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed">
      <code>{nodes}</code>
    </pre>
  )
}

const faqs = [
  {
    q: "What does the chain actually see?",
    a: "One deposit going in and salary-sized payouts coming out of the pool - plus commitments, nullifiers, and zero-knowledge proofs. What it never sees: which deposit funded which salary, the amounts in between, or the company's remaining shielded balance.",
  },
  {
    q: "Do employees need SOL to claim?",
    a: "No. Claims are relayed, so employees pay zero gas - a wallet with nothing in it can still receive and claim a private note. The employer's run needs one signature total, and none at all once the vault is funded.",
  },
  {
    q: "How fast is a real payroll run?",
    a: "A 100-person run takes about 80 seconds end to end - down from roughly 10 minutes before the current pipeline. Every proof is built in the employee's browser (~0.8s each); the relayer only broadcasts pre-signed transactions. Every number on this page is from a logged run.",
  },
  {
    q: "Can this be audited?",
    a: "Deposits and exits are public by design - that is the boundary of the privacy. The employer keeps per-run receipts with every proof and signature, so the company can always account for its own payroll. Recipient-scoped viewing keys (share one payment's history without exposing anything else) are on the roadmap, not shipped yet.",
  },
  {
    q: "Which tokens are supported?",
    a: "SOL payroll runs today. The private-note format (v2) is token-agnostic, so SPL stablecoins like USDC are the natural next pool - the circuit and tree do not care what the note represents.",
  },
]

/** Two stacked representations that crossfade on the lantern state — the hero
 *  panel's "public while the lamp is lit, blind once it dims" storytelling.
 *  Both layers share one grid cell so sizing follows the wider of the two. */
function Crossfade({
  lit,
  on,
  off,
  className,
}: {
  lit: boolean
  on: ReactNode
  off: ReactNode
  className?: string
}) {
  return (
    <span className={`inline-grid justify-items-center ${className ?? ""}`}>
      <span
        className={`[grid-area:1/1] transition-opacity duration-[1200ms] ease-out ${
          lit ? "opacity-100" : "opacity-0"
        }`}
      >
        {on}
      </span>
      <span
        aria-hidden
        className={`[grid-area:1/1] whitespace-nowrap transition-opacity duration-[1200ms] ease-out ${
          lit ? "opacity-0" : "opacity-100"
        }`}
      >
        {off}
      </span>
    </span>
  )
}

const publicRows = [
  { who: "Alex R. (VP Engineering)", amt: "2.10 SOL" },
  { who: "Elena S. (Principal ZK Dev)", amt: "1.40 SOL" },
  { who: "Design Lead (Contractor)", amt: "0.90 SOL" },
]

// mock run rows keyed to the animated progress bar: payAt = paid-count tick
// where the row is mid-proof (proving); past it the row flips to sent
const runRows = [
  { who: "Alex R.", dept: "Engineering", init: "AR", amt: "0.85 SOL", payAt: 3 },
  { who: "Mia T.", dept: "Design", init: "MT", amt: "1.10 SOL", payAt: 8 },
  { who: "Dan W.", dept: "Operations", init: "DW", amt: "1.85 SOL", payAt: 13 },
  { who: "Sara K.", dept: "Marketing", init: "SK", amt: "0.60 SOL", payAt: 18 },
]

const noteRowsMock = [
  { leaf: "#41", at: "Oct 24" },
  { leaf: "#42", at: "Oct 24" },
  { leaf: "#57", at: "Nov 02" },
]

/* ---------- small pieces ---------- */

function RunStatusChip({ status }: { status: string }) {
  if (status === "sent")
    return (
      <span className="tag tag--priv flex-none">
        <Check className="size-3" /> sent
      </span>
    )
  if (status === "proving")
    return (
      <span className="tag flex-none bg-panel text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> proving
      </span>
    )
  return (
    <span className="tag flex-none text-muted-foreground">queued</span>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.14em] text-gold">
      {children}
    </div>
  )
}

/* ---------- landing ---------- */

/** split text into staggered word spans for the hero rise */
function rise(text: string, baseDelay = 0) {
  return text.split(" ").map((w, i) => (
    <span key={`${w}-${i}`} style={{ animationDelay: `${baseDelay + i * 55}ms` }}>
      {w}
      {" "}
    </span>
  ))
}

export function Landing({ onRole }: { onRole: (r: "employer" | "employee") => void }) {
  // Lenis smooth scrolling drives the whole landing; the tick ruler on the
  // left edge replaces both the browser scrollbar and the old top hairline.
  return (
    <SmoothScroll root className="relative min-h-dvh">
      <LandingBody onRole={onRole} />
    </SmoothScroll>
  )
}

function LandingBody({ onRole }: { onRole: (r: "employer" | "employee") => void }) {
  // The lantern starts lit on every fresh load (?static screenshots render it
  // already dimmed), then dims once after 3s — it stays off until the user
  // refreshes, which is the only thing that re-runs this timer.
  const [lanternLit, setLanternLit] = useState(
    () => typeof document === "undefined" || !document.documentElement.classList.contains("static"),
  )
  useEffect(() => {
    const t = setTimeout(() => setLanternLit(false), 3000)
    return () => clearTimeout(t)
  }, [])

  // the mock payroll run: pays 0 -> 20 people (~8s), holds complete for a
  // beat, then restarts. Row statuses and amounts ride the same counter.
  // ?static seeds 13/20 so screenshots catch a mid-run frame.
  const [runTick, setRunTick] = useState(
    () =>
      typeof document === "undefined" || !document.documentElement.classList.contains("static")
        ? 0
        : 13,
  )
  useEffect(() => {
    const t = setInterval(() => setRunTick((p) => (p >= 26 ? 0 : p + 1)), 420)
    return () => clearInterval(t)
  }, [])
  const runPaid = Math.min(runTick, 20)

  // reveal-on-scroll for every section
  useEffect(() => {
    const els = Array.from(document.querySelectorAll("[data-reveal]"))
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("reveal-in"))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("reveal-in")
            io.unobserve(e.target)
          }
        }
      },
      { threshold: 0.1 },
    )
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [])

  const { scrollTo: smoothScrollTo } = useSmoothScroll()
  const scrollTo = (id: string) => {
    smoothScrollTo(`#${id}`)
  }

  return (
    <div className="relative min-h-dvh">
      <ScrollRuler />
      <div className="aurora" aria-hidden>
        <div className="caustic" />
        <div className="grid-lines" />
      </div>

      {/* ---------- fixed header ---------- */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-line bg-paper/90 shadow-[0_1px_4px_rgba(21,19,15,0.04)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1150px] items-center justify-between gap-4 px-4 sm:px-8">
          <div className="flex items-center gap-6">
            <button onClick={() => scrollTo("overview")} className="flex cursor-pointer items-center gap-2 outline-none">
              <img src="/charon-mark.png" alt="Charon Pay" className="size-7 rounded-full object-cover" />
              <span className="whitespace-nowrap text-[1.05rem] font-semibold tracking-tight">Charon Pay</span>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded bg-panel-2 px-2 py-1 md:flex">
              <span className="size-2 animate-pulse rounded-full bg-ok" />
              <span className="font-mono text-[11px] text-body-ink">Solana Devnet</span>
            </div>
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={() => onRole("employee")} className="hidden sm:inline-flex">
              Employee sign in
            </Button>
            <Button size="sm" className="btn-glow press" onClick={() => onRole("employer")}>
              <span className="swap swap-hover">
                <span className="swap-a">Launch App</span>
                <span className="swap-b">Run payroll</span>
              </span>
              <Ms name="arrow_forward" className="text-base transition-transform duration-200 group-hover:translate-x-0.5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="pt-16">
        {/* ================= HERO ================= */}
        <section id="overview" className="relative flex scroll-mt-20 flex-col items-center px-4 pb-16 pt-16 text-center sm:pt-24 md:pb-24">
          <h1 className="anim anim-1 mt-6 max-w-4xl text-[2rem] font-semibold leading-[1.15] tracking-[-0.03em] sm:text-[2.5rem] sm:leading-[1.2]">
            <span className="word-rise">{rise("Pay your whole team.", 0.05)}</span>{" "}
            <span className="word-rise font-normal gold-lit-text">{rise("In private.", 0.35)}</span>
          </h1>

          <p className="anim anim-3 mt-4 max-w-2xl text-pretty text-base leading-relaxed text-body-ink">
            Private batch payroll on Solana: salaries and treasury hidden from explorers.
          </p>

          <div className="anim anim-4 mt-8 flex flex-wrap items-center justify-center gap-3">
            <Magnetic strength={3}>
              <Button size="lg" className="btn-glow press rounded-xl" onClick={() => onRole("employer")}>
                <span className="swap swap-hover">
                  <span className="swap-a">Launch App</span>
                  <span className="swap-b">Run payroll</span>
                </span>
                <Ms name="arrow_forward" className="text-base transition-transform duration-200 hover:translate-x-0.5" />
              </Button>
            </Magnetic>
            <Button
              size="lg"
              variant="outline"
              className="press rounded-xl"
              onClick={() => scrollTo("comparison")}
            >
              <Ms name="terminal" className="text-base text-body-ink" />
              Explore Architecture
            </Button>
          </div>

          {/* hero visual: the ferryman over the live run panel. The lantern
              starts lit (amber glow) on every fresh load, then dims after 3s
              and stays off until the next refresh - ?static renders it off. */}
          <div id="demo-preview" className="anim anim-5 relative mt-10 flex w-full max-w-4xl flex-col items-center">
            <button
              type="button"
              aria-pressed={lanternLit}
              title={lanternLit ? "Go shielded" : "Relight the lantern"}
              onClick={() => setLanternLit((l) => !l)}
              className="relative z-20 -mb-4 size-40 cursor-pointer transition-transform duration-700 hover:scale-105 sm:-mb-14 md:size-48"
            >
              <div
                className={`absolute inset-0 rounded-full bg-[var(--gold-2)] blur-2xl transition-opacity duration-1000 ${
                  lanternLit ? "animate-pulse opacity-40" : "opacity-15"
                }`}
              />
              {/* off lantern (base layer) */}
              <img
                src="/charon-mark.png"
                alt="Charon, the ferryman"
                className="absolute inset-0 size-full object-contain drop-shadow-[0_16px_28px_rgba(21,19,15,0.18)]"
              />
              {/* lit lantern: fades out once the 2s lamp timer fires */}
              <img
                src="/charon-lit.png"
                alt=""
                aria-hidden
                className={`absolute inset-0 z-10 size-full object-contain transition-opacity duration-[1200ms] ease-out ${
                  lanternLit
                    ? "opacity-100 drop-shadow-[0_0_42px_rgba(232,168,66,0.45)]"
                    : "pointer-events-none opacity-0"
                }`}
              />
            </button>

            <Tilt className="w-full">
              <div className="relative z-10 w-full rounded-xl border border-line bg-card p-4 text-left shadow-[0_10px_35px_rgba(21,19,15,0.06)] transition-all duration-300 hover:shadow-[0_16px_45px_rgba(21,19,15,0.1)] sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-panel-2 pb-4">
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-gold-line bg-gold-soft px-2 py-0.5 font-mono text-xs font-semibold text-gold">
                      <Scramble text="RUN #1042" duration={640} />
                    </span>
                    <span className="flex items-center gap-1.5 rounded border border-ok-line bg-ok-soft px-2 py-0.5 font-mono text-[11px] font-medium text-ok">
                      <span className="size-1.5 rounded-full bg-ok" /> Instant Finality
                    </span>
                    {/* the lantern IS the privacy story: lit = operator preview,
                        dim = everything went private */}
                    <Crossfade
                      lit={lanternLit}
                      on={
                        <span className="flex items-center gap-1.5 rounded border border-warn-line bg-warn-soft px-2 py-0.5 font-mono text-[11px] font-medium text-warn">
                          <span className="size-1.5 rounded-full bg-warn" /> Public preview
                        </span>
                      }
                      off={
                        <span className="flex items-center gap-1.5 rounded border border-ok-line bg-ok-soft px-2 py-0.5 font-mono text-[11px] font-medium text-ok">
                          <span className="size-1.5 rounded-full bg-ok" /> Shielded
                        </span>
                      }
                    />
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[11px] text-body-ink">
                    <span>
                      Treasury Pool:{" "}
                      <Crossfade
                        lit={lanternLit}
                        on={<span className="font-medium text-ink">0x8A...3Fe9</span>}
                        off={<span className="tracking-widest text-mute">0x··…····</span>}
                      />
                    </span>
                    <span className="text-line-2">•</span>
                    <span className="flex items-center gap-1 font-medium text-ok">
                      <Ms name="shield" className="text-sm" /> Zero Leakage
                    </span>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
                  {(
                    [
                      {
                        k: "Masked Total",
                        v: (
                          <Crossfade
                            lit={lanternLit}
                            on={<CountUp to={8.7} decimals={4} />}
                            off={<span className="tracking-[0.3em]">········</span>}
                          />
                        ),
                        u: "SOL",
                        s: "zk-SNARK payload",
                        cls: "text-ink",
                      },
                      {
                        k: "Verified State",
                        v: <CountUp to={100} />,
                        u: "/100",
                        s: "0 failed payouts",
                        cls: "text-ok",
                      },
                      {
                        k: "Proof Compilation",
                        v: <CountUp to={0.8} decimals={1} />,
                        u: "s",
                        s: "on-device Groth16",
                        cls: "text-ink",
                      },
                      {
                        // 0% while the lamp is lit (you can see everything),
                        // glides back to 100% the moment it dims
                        k: "Privacy Level",
                        v: <CountUp to={lanternLit ? 0 : 100} />,
                        u: "%",
                        s: lanternLit ? "public preview" : "shielded tree pool",
                        cls: lanternLit ? "text-warn" : "text-gold",
                        lock: true,
                      },
                    ] satisfies { k: string; v: ReactNode; u: string; s: string; cls: string; lock?: boolean }[]
                  ).map((t) => (
                    <div key={t.k} className="rounded-lg border border-[#e5e2da] bg-paper p-4 dark:border-line">
                      <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-body-ink">
                        {t.k}
                      </div>
                      <div className={`mt-1 flex items-baseline gap-1 text-xl font-semibold transition-colors duration-[1200ms] ${t.cls}`}>
                        {t.v}
                        <span className="font-mono text-[11px] font-semibold text-gold">{t.u}</span>
                        {t.lock && <Ms name={lanternLit ? "lock_open" : "lock"} className="text-base" fill />}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-body-ink">{t.s}</div>
                    </div>
                  ))}
                </div>

                {/* confidential commitments mini-table */}
                <div className="mt-4 rounded-lg border border-line bg-panel p-2">
                  <div className="flex items-center justify-between px-2 py-1 font-mono text-[11px] font-medium uppercase tracking-wider text-body-ink">
                    <span>Confidential Recipient Commitment</span>
                    <span className="hidden sm:inline">Shielded Yield</span>
                    <span>ZK Status</span>
                  </div>
                  <div className="mt-1 space-y-1">
                    {[
                      ["cm_9f0a...471c", "Senior Cryptographer", "1.2450"],
                      ["cm_3e21...8b40", "Rust Runtime Core", "0.8310"],
                    ].map(([cm, role, amt]) => (
                      <div
                        key={cm}
                        className="flex items-center justify-between rounded border border-[#e5e2da] bg-card px-2 py-2 font-mono text-[11px] shadow-xs transition-colors hover:border-[color-mix(in_srgb,var(--gold-2)_40%,transparent)] dark:border-line"
                      >
                        <span className="font-medium text-ink">
                          {cm} <span className="hidden font-normal text-body-ink md:inline">({role})</span>
                        </span>
                        <Crossfade
                          lit={lanternLit}
                          className="hidden sm:inline"
                          on={<span className="font-semibold text-ink">{amt} SOL</span>}
                          off={<span className="tracking-widest text-mute">•••••••• SOL</span>}
                        />
                        <span className="flex items-center gap-1 font-medium text-ok">
                          <span className="size-1.5 rounded-full bg-ok" /> Verified
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </Tilt>
          </div>
        </section>

        {/* ================= BENCHMARK BENTO ================= */}
        <section id="benchmarks" data-reveal className="mx-auto w-full scroll-mt-20 max-w-[1150px] px-4 py-14 sm:px-8 md:py-20">
          <div className="flex flex-col justify-between gap-4 pb-6 md:flex-row md:items-baseline">
            <div>
              <SectionLabel>Empirical Benchmarks</SectionLabel>
              <h2 className="mt-1 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
                Zero-Knowledge at Solana Speed
              </h2>
            </div>
          </div>
          <div data-stagger className="grid grid-cols-1 gap-4 md:grid-cols-3 lg:grid-cols-5">
            {bento.map((m) => (
              <div
                key={m.label}
                className="specular group flex flex-col justify-between rounded-xl border border-line bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--gold-2)_50%,transparent)] hover:shadow-md"
              >
                <div>
                  <Ms name={m.icon} className={`text-2xl transition-transform group-hover:scale-110 ${m.iconCls}`} />
                  <div className={`stat-number mt-4 text-[1.75rem] font-semibold tracking-tight ${m.cls}`}>
                    <CountUp to={m.v} decimals={"decimals" in m ? (m.decimals as number) : 0} />
                    {m.unit}
                  </div>
                  <div className="mt-0.5 text-[13px] font-medium text-ink">{m.label}</div>
                </div>
                <div className="mt-4 text-xs leading-relaxed text-body-ink">{m.body}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ================= HOW IT WORKS ================= */}
        <section id="how" data-reveal className="mx-auto w-full scroll-mt-20 max-w-[1150px] px-4 py-14 sm:px-8 md:py-16">
          <div className="text-center">
            <SectionLabel>Protocol Flow</SectionLabel>
            <h2 className="mt-1 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              Four stages, one signature, one merkle tree
            </h2>
          </div>
          <div data-stagger className="relative mt-10 grid gap-4 md:grid-cols-4">
            <div
              aria-hidden
              className="absolute left-0 right-0 top-10 hidden h-px bg-gradient-to-r from-transparent via-[var(--gold-2)] to-transparent opacity-40 md:block"
            />
            {steps.map((s) => (
              <div
                key={s.n}
                className="specular relative rounded-xl border border-line bg-card p-5 transition-all hover:border-[color-mix(in_srgb,var(--gold-2)_45%,transparent)] hover:shadow-md"
              >
                <div className="relative z-10 mb-3 flex items-center gap-2">
                  <span className="flex size-9 items-center justify-center rounded-lg border border-gold-line bg-gold-soft text-gold">
                    <Ms name={s.icon} className="text-lg" />
                  </span>
                  <span className="font-mono text-xs text-mute">0{s.n}</span>
                </div>
                <div className="text-base font-semibold tracking-tight">{s.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-body-ink">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ================= THREAT MODEL COMPARISON ================= */}
        <section id="comparison" data-reveal className="mx-auto w-full scroll-mt-20 max-w-[1150px] px-4 py-14 sm:px-8 md:py-20">
          <div className="mx-auto max-w-2xl pb-8 text-center">
            <SectionLabel>Institutional Threat Model</SectionLabel>
            <h2 className="mt-1 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              Transparent Exploitation vs. Cryptographic Shielding
            </h2>
          </div>
          <div data-stagger className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* transparent side */}
            <div className="flex flex-col justify-between overflow-hidden rounded-xl border border-[var(--critical-line)] bg-card p-6 shadow-sm transition-all hover:shadow-md">
              <div>
                <div className="flex items-center justify-between border-b border-[color-mix(in_srgb,var(--critical-soft)_60%,transparent)] pb-4">
                  <div className="flex items-center gap-1.5">
                    <Ms name="visibility" className="text-xl text-critical" />
                    <span className="text-sm font-semibold text-critical">Public Solana Explorer</span>
                  </div>
                  <span className="rounded bg-[var(--critical-soft)] px-2 py-0.5 font-mono text-[11px] font-semibold text-critical-deep">
                    High Risk Exposure
                  </span>
                </div>
                <p className="my-4 text-xs leading-relaxed text-body-ink">
                  Anyone with a wallet explorer can query your corporate treasury balance,
                  individual salaries, and contractor identities.
                </p>
                <div className="space-y-1.5 font-mono text-xs">
                  <div className="flex items-center justify-between rounded border border-[var(--critical-line)] bg-[var(--critical-soft)] p-2.5 text-body-ink">
                    <div>
                      <span className="font-semibold text-ink">Sender:</span>
                      <span className="ml-1 text-critical">Treasury_Alpha.sol</span>
                    </div>
                    <span className="font-semibold text-critical">Total: 8.70 SOL</span>
                  </div>
                  <div className="space-y-2 rounded border border-[var(--critical-line)] bg-[var(--critical-soft)] p-2.5">
                    {publicRows.map((r) => (
                      <div key={r.who} className="flex items-center justify-between text-body-ink">
                        <span>{r.who}</span>
                        <span className="font-semibold text-critical">+{r.amt}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="-mx-6 -mb-6 mt-6 flex items-center gap-2 border-t border-[var(--critical-line)] bg-[var(--critical-soft)] p-4 text-xs text-critical">
                <Ms name="warning" className="text-base" />
                <span>Permanent public linkability between payroll wallets and personal identities.</span>
              </div>
            </div>

            {/* shielded side */}
            <div className="flex flex-col justify-between overflow-hidden rounded-xl border border-ok-line bg-card p-6 shadow-sm transition-all hover:shadow-md">
              <div>
                <div className="flex items-center justify-between border-b border-ok-soft pb-4">
                  <div className="flex items-center gap-1.5">
                    <Ms name="shield_lock" className="text-xl text-ok" />
                    <span className="text-sm font-semibold text-ok">Charon Shielded Ledger</span>
                  </div>
                  <span className="rounded border border-ok-line bg-ok-soft px-2 py-0.5 font-mono text-[11px] font-semibold text-ok">
                    Fully Confidential
                  </span>
                </div>
                <p className="my-4 text-xs leading-relaxed text-body-ink">
                  Zero-knowledge roots break all linkage between company outflows and personal
                  withdrawal receipts.
                </p>
                <div className="space-y-1.5 font-mono text-xs">
                  <div className="flex items-center justify-between rounded border border-ok-line bg-[var(--ok-soft)] p-2.5 text-body-ink">
                    <div>
                      <span className="font-semibold text-ink">Sender:</span>
                      <span className="ml-1 text-gold">Shielded Settlement Pool</span>
                    </div>
                    <span className="font-semibold text-ok">Batch ZK-Root: 0x9c4...f1</span>
                  </div>
                  <div className="space-y-2 rounded border border-ok-line bg-[var(--ok-soft)] p-2.5">
                    {["#01", "#02", "#03"].map((i) => (
                      <div key={i} className="flex items-center justify-between text-body-ink">
                        <span className="text-mute">Anonymous Commitment {i}</span>
                        <span className="font-semibold tracking-widest text-ok">•••••• SOL</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="-mx-6 -mb-6 mt-6 flex items-center gap-2 border-t border-ok-line bg-ok-soft p-4 text-xs text-ok">
                <Ms name="verified" className="text-base" />
                <span>Zero observer leakage. Compliance-ready viewing keys available for auditors.</span>
              </div>
            </div>
          </div>
        </section>

        {/* ================= CAPABILITIES ================= */}
        <section data-reveal className="mx-auto w-full max-w-[1150px] px-4 py-12 sm:px-8">
          <div className="text-center">
            <SectionLabel>Capabilities</SectionLabel>
            <h2 className="mt-1 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              Everything a payroll run needs
            </h2>
          </div>
          <div data-stagger className="mt-8 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {capabilities.map((c) => (
              <div key={c} className="flex items-start gap-3 text-sm text-body-ink">
                <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-ok-soft">
                  <Check className="size-3 text-ok" />
                </span>
                {c}
              </div>
            ))}
          </div>
        </section>

        {/* ================= RUNTIME MEASUREMENTS ================= */}
        <section data-reveal className="mx-auto w-full max-w-[1150px] px-4 py-12 sm:px-8">
          <div className="mb-8 text-center">
            <SectionLabel>Benchmarks</SectionLabel>
            <h2 className="mt-1 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              Measured, not promised
            </h2>
            <p className="mt-1 text-sm text-body-ink">
              Same 100 unequal salaries, measured on devnet. Bars are to scale.
            </p>
          </div>
          <div data-stagger className="grid gap-4 lg:grid-cols-2">
            <Card className="card-lift specular rounded-xl">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">Pay a team of 100, end to end</CardTitle>
                <span className="stat-number text-lg font-bold">~80s</span>
              </CardHeader>
              <CardContent className="space-y-5">
                {runtimeBars.map((b) => (
                  <div key={b.label}>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                      <span className="text-body-ink">{b.label}</span>
                      <span className="stat-number font-bold">{b.v}</span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-md bg-panel-2">
                      <div className={`chart-bar h-full rounded-md ${b.cls}`} style={{ "--w": b.w } as CSSProperties} />
                    </div>
                  </div>
                ))}
                <p className="text-xs leading-relaxed text-body-ink">
                  First signature to last confirmation - every proof built on-device in parallel, the relayer just broadcasts.
                </p>
              </CardContent>
            </Card>
            <Card className="card-lift specular rounded-xl">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">One salary through the pool</CardTitle>
                <span className="stat-number text-lg font-bold">0.8s</span>
              </CardHeader>
              <CardContent className="space-y-2">
                {pipeline.map((st) => (
                  <div key={st.n} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block font-mono text-xs font-medium">{st.n}</span>
                      <span className="block text-[11px] leading-relaxed text-body-ink">{st.d}</span>
                    </span>
                    <span className="stat-number flex-none text-sm font-bold">{st.v}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ================= EMPLOYER USE CASE ================= */}
        <section data-reveal className="mx-auto grid w-full max-w-[1150px] items-center gap-10 px-4 py-12 sm:px-8 lg:grid-cols-2">
          <div>
            <SectionLabel>For Employers</SectionLabel>
            <h2 className="mt-1 mb-3 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              The whole run, from one screen
            </h2>
            <p className="text-sm leading-relaxed text-body-ink">
              Connect your wallet, drop in a CSV, review the plan, then sign once.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-body-ink">
              {[
                "CSV / JSON upload with per-row validation",
                "Public mode or fully shielded notes per run",
                "Live progress, receipts, one-click resume of failed rows",
                "One signature for the whole run - zero when the vault is funded",
              ].map((li) => (
                <li key={li} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 flex-none text-ok" />
                  {li}
                </li>
              ))}
            </ul>
            <Button className="btn-glow group mt-6" onClick={() => onRole("employer")}>
              Sign in as employer
              <Ms name="arrow_forward" className="text-base transition-transform group-hover:translate-x-0.5" />
            </Button>
          </div>
          <Card className="card-lift specular mx-auto w-full max-w-md rounded-xl shadow-[0_10px_35px_rgba(21,19,15,0.06)]">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="flex h-7 min-w-7 flex-none items-center justify-center whitespace-nowrap rounded-lg border border-gold-line bg-gold-soft px-2 font-mono text-[11px] font-semibold text-gold">
                    #2847
                  </span>
                  October payroll
                </span>
                <span className="tag tag--priv">
                  <Ms name="shield" className="text-xs" /> shielded
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-body-ink">
                  <span>paying 20 people</span>
                  <span className="font-mono">{runPaid} / 20</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-panel-2">
                  <div
                    className="progress-glow h-full transition-[width] duration-300 ease-linear"
                    style={{ width: `${(runPaid / 20) * 100}%` }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                {runRows.map((r) => {
                  const status =
                    runPaid > r.payAt ? "sent" : runPaid === r.payAt ? "proving" : "queued"
                  return (
                    <div key={r.who} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 transition-colors hover:border-[color-mix(in_srgb,var(--gold-2)_35%,transparent)]">
                      <span className="flex size-7 flex-none items-center justify-center rounded-full bg-panel-2 font-mono text-[11px] font-semibold text-body-ink">
                        {r.init}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{r.who}</span>
                        <span className="hidden text-[11px] text-body-ink sm:block">{r.dept}</span>
                      </span>
                      <span className="font-mono text-xs">{status === "proving" ? r.amt : "******"}</span>
                      <RunStatusChip status={status} />
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center justify-between border-t pt-3 text-xs text-body-ink">
                <span>total disbursed</span>
                <span className="font-mono">****** · est. fees 0.022 SOL</span>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ================= EMPLOYEE USE CASE ================= */}
        <section data-reveal className="mx-auto grid w-full max-w-[1150px] items-center gap-10 px-4 py-12 sm:px-8 lg:grid-cols-2">
          <Card className="card-lift specular order-2 mx-auto w-full max-w-sm rounded-xl shadow-[0_10px_35px_rgba(21,19,15,0.06)] lg:order-1">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm">
                <span>My payments</span>
                <span className="tag font-mono text-[11px]">7fKq...3wPd</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg border border-line bg-panel p-3">
                  <p className="font-mono text-[11px] uppercase tracking-wider text-body-ink">Private notes</p>
                  <p className="stat-number mt-0.5 text-lg font-bold">4.15 SOL</p>
                  <p className="text-[11px] text-body-ink">3 notes, shielded</p>
                </div>
                <div className="rounded-lg border border-line bg-panel p-3">
                  <p className="font-mono text-[11px] uppercase tracking-wider text-body-ink">Wallet balance</p>
                  <p className="stat-number mt-0.5 text-lg font-bold">0.42 SOL</p>
                  <p className="text-[11px] text-body-ink">public, spendable</p>
                </div>
              </div>
              <div className="space-y-2">
                {noteRowsMock.map((n) => (
                  <div key={n.leaf} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs transition-colors hover:border-[color-mix(in_srgb,var(--gold-2)_35%,transparent)]">
                    <span className="font-mono font-medium">**** SOL</span>
                    <span className="text-body-ink">note {n.leaf}</span>
                    <span className="hidden text-body-ink sm:inline">{n.at}</span>
                    <span className="tag tag--gold">claimable</span>
                  </div>
                ))}
              </div>
              <Button className="btn-glow w-full">Claim to wallet</Button>
              <p className="text-center text-[11px] text-body-ink">
                gasless - no SOL needed, the relayer submits for you
              </p>
            </CardContent>
          </Card>
          <div className="order-1 lg:order-2">
            <SectionLabel>For Employees</SectionLabel>
            <h2 className="mt-1 mb-3 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              Get paid without publishing it
            </h2>
            <p className="text-sm leading-relaxed text-body-ink">
              Your regular wallet is all you need. Payouts arrive as private notes.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-body-ink">
              {[
                "One-time enable - two signatures, then nothing to do",
                "See every payment that's yours, amounts hidden from others",
                "Claim notes to plain SOL whenever you like, gasless",
              ].map((li) => (
                <li key={li} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 flex-none text-ok" />
                  {li}
                </li>
              ))}
            </ul>
            <Button className="mt-6" variant="outline" onClick={() => onRole("employee")}>
              Sign in as employee
              <Ms name="arrow_forward" className="text-base" />
            </Button>
          </div>
        </section>

        {/* ================= DEVELOPERS / SDK ================= */}
        {/* hidden for now: the SDK is not publicly offered yet */}
        {false && (
        <section id="developers" data-reveal className="mx-auto grid w-full scroll-mt-20 max-w-[1150px] items-center gap-8 px-4 py-12 sm:px-8 lg:grid-cols-2">
          <div>
            <SectionLabel>For Developers</SectionLabel>
            <h2 className="mt-1 mb-3 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">
              One SDK, the whole pool
            </h2>
            <p className="text-sm leading-relaxed text-body-ink">
              The TypeScript SDK talks to your wallet and the relayer: scanning, note decryption,
              proof generation, and gasless claims - without running provers, syncing merkle trees,
              or shipping circuit builds yourself.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-body-ink">
              {[
                "Browser-native Groth16 proving - proofs built in your app, never on a server",
                "Recipients registry - notes encrypted to published keys",
                "Note backup, restore, and export built in",
              ].map((li) => (
                <li key={li} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 flex-none text-ok" />
                  {li}
                </li>
              ))}
            </ul>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-[0_1px_2px_rgba(9,9,11,0.03),0_14px_36px_-16px_rgba(9,9,11,0.14)]">
            <div className="flex items-center gap-1.5 border-b border-line px-5 py-3">
              <span className="size-2.5 rounded-full bg-[#e8a9a2]" />
              <span className="size-2.5 rounded-full bg-[#ecd394]" />
              <span className="size-2.5 rounded-full bg-[#a8cfb5]" />
              <span className="mono ml-2 text-[11px] text-mute">claim.ts</span>
              <Code2 className="ml-auto size-3.5 text-mute" />
            </div>
            <CodeBlock code={SDK_SNIPPET} />
          </div>
        </section>
        )}

        {/* ================= FAQ ================= */}
        <section id="faq" data-reveal className="mx-auto w-full max-w-3xl scroll-mt-20 px-4 py-12 sm:px-8">
          <div className="mb-8 text-center">
            <SectionLabel>FAQ</SectionLabel>
            <h2 className="mt-1 text-[1.6rem] font-semibold tracking-[-0.025em] sm:text-[2rem]">Questions, answered</h2>
            <p className="mt-1 text-sm text-body-ink">
              What the chain sees, what it costs, and what it cannot do yet.
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-card">
            {faqs.map((f) => (
              <details key={f.q} className="qa group border-b border-line px-5 py-4 last:border-b-0">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <ChevronDown className="size-4 flex-none text-body-ink transition-transform duration-300 group-open:rotate-180" />
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-body-ink">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ================= CTA: GIANT WORDMARK ================= */}
        <section data-reveal className="mx-auto w-full max-w-[1150px] px-4 py-16 sm:px-8 md:py-24">
          <div className="flex flex-col items-center gap-6 text-center">
            <h2 className="mark-gradient text-[clamp(3.2rem,10vw,8rem)] font-bold leading-[0.95] tracking-[-0.045em]">
              Leave no trace.
            </h2>
            <div className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
              <Button size="lg" className="btn-glow flex-1 rounded-lg" onClick={() => onRole("employer")}>
                Run payroll
                <Ms name="arrow_forward" className="text-base" />
              </Button>
              <Button size="lg" variant="outline" className="flex-1 rounded-lg" onClick={() => onRole("employee")}>
                I'm an employee
              </Button>
            </div>
          </div>
        </section>

        {/* ================= FOOTER ================= */}
        <footer className="border-t border-band-line bg-band">
          <div className="mx-auto flex w-full max-w-[1150px] flex-col items-center justify-between gap-2 px-4 py-4 font-mono text-[11px] text-band-mute sm:flex-row sm:px-8">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-band-gold" /> ZK Circuits: Validated
              </span>
              <span className="text-band-line">·</span>
              <span>Proof Time: 0.8s</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
              <span>Groth16 Finality Verified</span>
              <span className="text-band-line">·</span>
              <span>© 2026 Charon Pay Protocol Ltd.</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  )
}
