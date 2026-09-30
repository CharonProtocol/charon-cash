import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleDashed,
  Code2,
  EyeOff,
  Loader2,
  ShieldCheck,
} from "lucide-react"

import { useEffect, type CSSProperties } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ThemeToggle } from "@/components/ThemeToggle"

const stats = [
  { v: "67.6s", l: "to pay 210 salaries", sub: "standard circuit, 16-lane stack with the server-side prover" },
  { v: "11.32s", l: "the same payroll, batched", sub: "batched-circuit bench pipeline" },
  { v: "210 / 210", l: "paid exact", sub: "unequal salaries, 0 failures" },
  { v: "1", l: "signature per run", sub: "0 when the vault is funded" },
]

const steps = [
  {
    n: "1",
    title: "Fund",
    body: "The treasury deposits one lump sum into the shielded pool. Public: the amount in. Hidden: everything after.",
  },
  {
    n: "2",
    title: "Split",
    body: "Funds are shielded into pool wallets as merkle-tree commitments — no addresses, no amounts, just hashes.",
  },
  {
    n: "3",
    title: "Pay",
    body: "Every salary leaves with its own zero-knowledge proof. 210 people in ~68 seconds on a tuned relayer, 0 failures.",
  },
  {
    n: "4",
    title: "Claim",
    body: "Employees hold private notes in their wallet and claim to plain SOL whenever they want — gasless.",
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
  { label: "before optimization", v: "902s", w: "100%", cls: "bg-zinc-300 dark:bg-zinc-700" },
  { label: "today - standard circuit", v: "67.6s", w: "7.5%", cls: "bg-emerald-500" },
  { label: "batched pipeline (bench)", v: "11.32s", w: "1.25%", cls: "bg-zinc-900 dark:bg-zinc-100" },
]

const pipeline = [
  { n: "zk proof", v: "0.28s", d: "one Groth16 proof, built in-process on the relayer" },
  { n: "batched write", v: "8 / tx", d: "salaries packed into a single on-chain transaction" },
  { n: "browser proof", v: "~4s", d: "snarkjs in the employee's wallet when they claim" },
]

const SDK_SNIPPET = `import { PrivacyCashClient, publishRecipientKeys } from "privacy-cash-sdk"

// employees publish receiving keys once - notes are encrypted to them
await publishRecipientKeys({ publicKey, signMessage, signTransaction })

const client = new PrivacyCashClient(signer)
await client.init()   // load the shielded pool view
await client.unlock() // decrypt your notes locally

// claim a private note to your wallet - gasless, relayed
const r = await client.withdrawSOL(amountLamports, recipient, { relay: true })`

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
    a: "Measured on an 8 GB laptop against a local validator: 210 unequal salaries in 67.6s on the standard circuit (63.3s packed), and the batched-circuit bench lands the same 210 in 11.32s. Every number on this page is from a logged run.",
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

/* ---------- product mockup data ---------- */

const publicLedger = [
  { what: "salary - engineering", to: "7fKq...3wPd", amt: "+2.10 SOL", at: "09:14" },
  { what: "salary - design", to: "9sBv...2kQn", amt: "+1.40 SOL", at: "09:14" },
  { what: "salary - operations", to: "4hTe...9xLm", amt: "+0.90 SOL", at: "09:15" },
  { what: "contractor payout", to: "2mWc...8rTf", amt: "+0.65 SOL", at: "09:15" },
  { what: "salary - marketing", to: "6pDn...5vKj", amt: "+1.15 SOL", at: "09:16" },
]

const shieldedLedger = [
  { what: "pool payout", to: "****...****", amt: "****", at: "09:14" },
  { what: "pool payout", to: "****...****", amt: "****", at: "09:14" },
  { what: "pool payout", to: "****...****", amt: "****", at: "09:15" },
  { what: "pool payout", to: "****...****", amt: "****", at: "09:15" },
  { what: "pool payout", to: "****...****", amt: "****", at: "09:16" },
]

const runRows = [
  { who: "Alex R.", dept: "Engineering", init: "AR", amt: "******", status: "sent" },
  { who: "Mia T.", dept: "Design", init: "MT", amt: "******", status: "sent" },
  { who: "Dan W.", dept: "Operations", init: "DW", amt: "1.85 SOL", status: "proving" },
  { who: "Sara K.", dept: "Marketing", init: "SK", amt: "******", status: "queued" },
]

const noteRowsMock = [
  { leaf: "#41", at: "Oct 24" },
  { leaf: "#42", at: "Oct 24" },
  { leaf: "#57", at: "Nov 02" },
]

function RunStatusChip({ status }: { status: string }) {
  if (status === "sent")
    return (
      <span className="inline-flex flex-none items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
        <Check className="size-3" /> sent
      </span>
    )
  if (status === "proving")
    return (
      <span className="inline-flex flex-none items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> proving
      </span>
    )
  return (
    <span className="inline-flex flex-none items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <CircleDashed className="size-3" /> queued
    </span>
  )
}

function LedgerRow({ what, to, amt, at, shielded }: { what: string; to: string; amt: string; at: string; shielded: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-secondary/70 px-3 py-2 text-xs transition-colors hover:bg-secondary">
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{what}</span>
      <span className="mono hidden text-muted-foreground sm:inline">{to}</span>
      <span className="font-mono font-medium">{amt}</span>
      <span className="hidden text-muted-foreground sm:inline">{at}</span>
      {shielded ? (
        <span className="tag tag--priv hidden md:inline-flex">shielded</span>
      ) : (
        <span className="tag tag--pub hidden md:inline-flex">public</span>
      )}
    </div>
  )
}

export function Landing({ onRole }: { onRole: (r: "employer" | "employee") => void }) {
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

  return (
    <div className="relative min-h-dvh">
      <div className="aurora" aria-hidden>
        <div className="grid-lines" />
      </div>

      <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            P
          </div>
          <span className="h-display hidden text-lg sm:inline">Charon Pay</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={() => onRole("employee")} className="hidden sm:inline-flex">
            Employee sign in
          </Button>
          <Button size="sm" className="group btn-glow" onClick={() => onRole("employer")}>
            Employer sign in
          </Button>
        </div>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="mx-auto max-w-5xl px-4 pb-6 pt-10 text-center sm:px-6 sm:pt-16">
        <Badge
          variant="secondary"
          className="anim anim-1 mb-6 rounded-full border-emerald-200 bg-emerald-50 px-3.5 py-1.5 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
        >
          <EyeOff className="mr-1 size-3" /> zero-knowledge payroll · solana
        </Badge>
        <h1 className="h-display anim anim-2 mx-auto max-w-3xl text-4xl leading-[1.05] sm:text-6xl">
          Pay your whole team.
          <br />
          <span className="text-gradient">In private.</span>
        </h1>
        <p className="anim anim-3 mx-auto mt-6 max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">
          Charon Pay routes salaries through a zero-knowledge pool on Solana. The chain records
          deposits and payouts — never who was paid, how much, or what the treasury still holds.
        </p>
        <div className="anim anim-4 mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" className="group btn-glow" onClick={() => onRole("employer")}>
            Run payroll <ArrowRight className="ml-1 size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => onRole("employee")}>
            I'm an employee
          </Button>
        </div>

        {/* hero product widget - the treasurer's screen, mid-run */}
        <Card className="anim anim-5 card-lift mx-auto mt-12 max-w-md border-border bg-card text-left shadow-[0_24px_60px_-24px_rgba(9,9,11,0.18)] dark:shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">October payroll</span>
              <Badge variant="secondary" className="gap-1">
                <EyeOff className="size-3" /> shielded
              </Badge>
            </div>
            <div className="stat-number mt-2 text-4xl font-bold">8.70 SOL</div>
            <p className="mt-1 text-xs text-muted-foreground">
              5 employees · est. fees 0.022 SOL · one signature
            </p>
            <div className="mt-5 mb-4">
              <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>paying 5 people</span>
                <span className="font-mono">3 / 5</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div className="progress-glow run-fill-live h-full w-[60%]" />
              </div>
            </div>
            <Button className="group btn-glow w-full" onClick={() => onRole("employer")}>
              Pay 5 employees now <ArrowRight className="ml-1 size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Button>
            <p className="mt-3 text-center text-[11px] text-muted-foreground">
              proofs built in your browser · payouts signed by the relayer · employees need zero SOL
            </p>
          </CardContent>
        </Card>
      </section>

      {/* ---------- the problem: your payroll is a public record ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
        <p className="eyebrow justify-center">Why private payroll</p>
        <h2 className="h-display mb-1 text-center text-3xl sm:text-4xl">Your payroll is a public record.</h2>
        <p className="mx-auto mb-10 max-w-xl text-center text-sm text-muted-foreground">
          On a normal wallet, every salary is permanent, public data — who you employ, what you pay
          them, and how much is left. The same run through the pool:
        </p>
        <div data-stagger className="grid gap-4 md:grid-cols-2">
          <Card className="card-lift">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>Public payroll</span>
                <span className="tag tag--pub">public</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between rounded-lg bg-secondary px-3 py-2.5 text-sm">
                <span className="text-muted-foreground">Treasury balance</span>
                <span className="stat-number font-bold">48.20 SOL</span>
              </div>
              {publicLedger.map((r, i) => (
                <LedgerRow key={i} what={r.what} to={r.to} amt={r.amt} at={r.at} shielded={false} />
              ))}
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                Every row is a permanent public record - salaries, headcount, and who still works
                there, readable by anyone with the treasury address.
              </p>
            </CardContent>
          </Card>
          <Card className="card-lift bg-secondary/50">
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>Shielded payroll</span>
                <span className="tag tag--priv">shielded</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between rounded-lg bg-card px-3 py-2.5 text-sm">
                <span className="text-muted-foreground">Treasury balance</span>
                <span className="stat-number font-bold">****</span>
              </div>
              {shieldedLedger.map((r, i) => (
                <LedgerRow key={i} what={r.what} to={r.to} amt={r.amt} at={r.at} shielded={true} />
              ))}
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                The deposit is public - which salary it funded never is. Amounts, recipients, and
                the remaining balance stay inside the pool.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ---------- stats ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6">
        <h2 className="h-display mx-auto max-w-2xl text-3xl sm:text-4xl">
          A 210-person payroll, start to confirmed, in about a minute.
        </h2>
        <div data-stagger className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 text-left lg:grid-cols-4">
          {stats.map((st) => (
            <div key={st.v}>
              <div className="stat-number text-3xl font-bold sm:text-4xl">{st.v}</div>
              <p className="mt-2 text-sm font-medium">{st.l}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{st.sub}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- employer use case: the run screen ---------- */}
      <section data-reveal className="mx-auto grid max-w-5xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
        <div>
          <p className="eyebrow">For employers</p>
          <h2 className="h-display mb-3 text-3xl">The whole run, from one screen</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Sign in with your treasury wallet, drop in a CSV, and review the exact plan and fees
            before anything is signed. Then watch every salary prove, relay, and confirm - live.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {[
              "CSV / JSON upload with per-row validation",
              "Public mode or fully shielded notes per run",
              "Live progress, receipts, one-click resume of failed rows",
              "One signature for the whole run - zero when the vault is funded",
            ].map((li) => (
              <li key={li} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 flex-none text-emerald-600 dark:text-emerald-400" />
                {li}
              </li>
            ))}
          </ul>
          <Button className="group btn-glow mt-6" onClick={() => onRole("employer")}>
            Sign in as employer <ArrowRight className="ml-1 size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Button>
        </div>
        <Card className="card-lift mx-auto w-full max-w-md border-border bg-card shadow-[0_24px_60px_-24px_rgba(9,9,11,0.18)] dark:shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-lg bg-secondary font-mono text-[11px] font-semibold text-muted-foreground">
                  #2847
                </span>
                October payroll
              </span>
              <Badge variant="secondary" className="gap-1">
                <EyeOff className="size-3" /> shielded
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground">
                <span>paying 20 people</span>
                <span className="font-mono">13 / 20</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div className="progress-glow run-fill-live h-full w-[65%]" />
              </div>
            </div>
            <div className="space-y-2">
              {runRows.map((r) => (
                <div key={r.who} className="flex items-center gap-3 rounded-lg bg-secondary/70 px-3 py-2 transition-colors hover:bg-secondary">
                  <span className="flex size-7 flex-none items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-muted-foreground">
                    {r.init}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{r.who}</span>
                    <span className="hidden text-[11px] text-muted-foreground sm:block">{r.dept}</span>
                  </span>
                  <span className="font-mono text-xs">{r.amt}</span>
                  <RunStatusChip status={r.status} />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
              <span>total disbursed</span>
              <span className="font-mono">****** · est. fees 0.022 SOL</span>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ---------- employee use case: the claim screen ---------- */}
      <section data-reveal className="mx-auto grid max-w-5xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2">
        <Card className="card-lift order-2 mx-auto w-full max-w-sm border-border bg-card shadow-[0_24px_60px_-24px_rgba(9,9,11,0.18)] dark:shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)] lg:order-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-sm">
              <span>My payments</span>
              <Badge variant="outline" className="font-mono text-[11px]">
                7fKq...3wPd
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-secondary/70 p-3">
                <p className="text-[11px] text-muted-foreground">Private notes</p>
                <p className="stat-number mt-0.5 text-lg font-bold">4.15 SOL</p>
                <p className="text-[11px] text-muted-foreground">3 notes, shielded</p>
              </div>
              <div className="rounded-lg bg-secondary/70 p-3">
                <p className="text-[11px] text-muted-foreground">Wallet balance</p>
                <p className="stat-number mt-0.5 text-lg font-bold">0.42 SOL</p>
                <p className="text-[11px] text-muted-foreground">public, spendable</p>
              </div>
            </div>
            <div className="space-y-2">
              {noteRowsMock.map((n) => (
                <div key={n.leaf} className="flex items-center justify-between gap-2 rounded-lg bg-secondary/70 px-3 py-2 text-xs transition-colors hover:bg-secondary">
                  <span className="font-mono font-medium">**** SOL</span>
                  <span className="text-muted-foreground">note {n.leaf}</span>
                  <span className="hidden text-muted-foreground sm:inline">{n.at}</span>
                  <span className="tag tag--priv">claimable</span>
                </div>
              ))}
            </div>
            <Button className="group btn-glow w-full">Claim to wallet</Button>
            <p className="text-center text-[11px] text-muted-foreground">
              gasless - no SOL needed, the relayer submits for you
            </p>
          </CardContent>
        </Card>
        <div className="order-1 lg:order-2">
          <p className="eyebrow">For employees</p>
          <h2 className="h-display mb-3 text-3xl">Get paid without publishing it</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your regular wallet is all you need. A one-time toggle publishes your receiving keys,
            and every payout after that arrives as a private note that only you can read.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {[
              "One-time enable - two signatures, then nothing to do",
              "See every payment that's yours - amounts hidden from everyone else",
              "Claim notes to plain SOL whenever you like, gasless",
            ].map((li) => (
              <li key={li} className="flex items-start gap-2">
                <Check className="mt-0.5 size-4 flex-none text-emerald-600 dark:text-emerald-400" />
                {li}
              </li>
            ))}
          </ul>
          <Button className="group mt-6" variant="outline" onClick={() => onRole("employee")}>
            Sign in as employee <ArrowRight className="ml-1 size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Button>
        </div>
      </section>

      {/* ---------- capabilities ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <p className="eyebrow justify-center">Capabilities</p>
        <h2 className="h-display mb-8 text-center text-3xl">Everything a payroll run needs</h2>
        <div data-stagger className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {capabilities.map((c) => (
            <div key={c} className="flex items-start gap-3 text-sm text-muted-foreground">
              <span className="mt-0.5 flex size-5 flex-none items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/10">
                <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
              </span>
              {c}
            </div>
          ))}
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <h2 className="h-display mb-1 text-center text-3xl">How it works</h2>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          Four stages, sixteen parallel lanes, one merkle tree.
        </p>
        <div data-stagger className="relative grid gap-3 md:grid-cols-4">
          <div
            aria-hidden
            className="absolute left-0 right-0 top-7 hidden h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent md:block"
          />
          {steps.map((s) => (
            <Card key={s.n} className="card-lift relative">
              <CardContent className="pt-6">
                <div className="relative z-10 mb-3 flex size-9 items-center justify-center rounded-full bg-secondary font-mono text-sm font-semibold text-primary">
                  {s.n}
                </div>
                <div className="font-medium">{s.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* ---------- benchmarks ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 py-14 sm:px-6">
        <p className="eyebrow justify-center">Benchmarks</p>
        <h2 className="h-display mb-1 text-center text-3xl">Measured, not promised</h2>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          Same 210 unequal salaries, same 8 GB laptop, local validator. Bars are to scale.
        </p>
        <div data-stagger className="grid gap-4 lg:grid-cols-2">
          <Card className="card-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">Pay a team of 210, end to end</CardTitle>
              <span className="stat-number text-lg font-bold">67.6s</span>
            </CardHeader>
            <CardContent className="space-y-5">
              {runtimeBars.map((b) => (
                <div key={b.label}>
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{b.label}</span>
                    <span className="stat-number font-bold">{b.v}</span>
                  </div>
                  <div className="h-3 w-full overflow-hidden rounded-md bg-secondary">
                    <div
                      className={`chart-bar h-full rounded-md ${b.cls}`}
                      style={{ "--w": b.w } as CSSProperties}
                    />
                  </div>
                </div>
              ))}
              <p className="text-xs leading-relaxed text-muted-foreground">
                First signature to last confirmation, on the bench stack (server-side prover, 16
                lanes). The browser UI today proves one-by-one with snarkjs (~4s/proof). The
                batched pipeline is bench-only.
              </p>
            </CardContent>
          </Card>
          <Card className="card-lift">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">One salary through the pool</CardTitle>
              <span className="stat-number text-lg font-bold">0.28s</span>
            </CardHeader>
            <CardContent className="space-y-2">
              {pipeline.map((st) => (
                <div key={st.n} className="flex items-start justify-between gap-3 rounded-xl bg-secondary/70 px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{st.n}</span>
                    <span className="block text-[11px] leading-relaxed text-muted-foreground">{st.d}</span>
                  </span>
                  <span className="stat-number flex-none text-sm font-bold">{st.v}</span>
                </div>
              ))}
              <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
                Proving runs 16 lanes wide, so a full run waits on submit and confirm - not
                proving.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ---------- developers ---------- */}
      <section data-reveal className="mx-auto grid max-w-5xl items-center gap-8 px-4 py-10 sm:px-6 lg:grid-cols-2">
        <div>
          <p className="eyebrow">For developers</p>
          <h2 className="h-display mb-3 text-3xl">One SDK, the whole pool</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The TypeScript SDK talks to your wallet and the relayer: scanning, note decryption, proof
            generation, and gasless claims - without running provers, syncing merkle trees, or
            shipping circuit builds yourself.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 flex-none text-emerald-600 dark:text-emerald-400" />
              Browser-native Groth16 proving (snarkjs), or relayer-side arkworks
            </li>
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 flex-none text-emerald-600 dark:text-emerald-400" />
              Recipients registry - notes encrypted to published keys
            </li>
            <li className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 flex-none text-emerald-600 dark:text-emerald-400" />
              Note backup, restore, and export built in
            </li>
          </ul>
        </div>
        <Card className="overflow-hidden bg-zinc-950 text-zinc-100 shadow-[0_1px_2px_rgba(9,9,11,0.03),0_14px_36px_-16px_rgba(9,9,11,0.14)] dark:bg-zinc-900">
          <CardContent className="px-0 py-0">
            <div className="flex items-center gap-1.5 border-b border-zinc-800 px-5 py-3">
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="mono ml-2 text-[11px] text-zinc-500">claim.ts</span>
              <Code2 className="ml-auto size-3.5 text-zinc-500" />
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed">
              <code>{SDK_SNIPPET}</code>
            </pre>
          </CardContent>
        </Card>
      </section>

      {/* ---------- faq ---------- */}
      <section data-reveal className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h2 className="h-display mb-1 text-center text-3xl">Questions, answered</h2>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          What the chain sees, what it costs, and what it cannot do yet.
        </p>
        <div className="divide-y overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(9,9,11,0.03),0_14px_36px_-16px_rgba(9,9,11,0.14)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),0_14px_36px_-16px_rgba(0,0,0,0.5)]">
          {faqs.map((f) => (
            <details key={f.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                {f.q}
                <ChevronDown className="size-4 flex-none text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ---------- what the chain never learns ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Card className="card-lift bg-secondary/50">
          <CardContent className="flex flex-col items-center gap-4 pt-6 text-center sm:flex-row sm:text-left">
            <ShieldCheck className="size-8 flex-none text-emerald-600 dark:text-emerald-400" />
            <div>
              <p className="font-medium">What the chain never learns</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Which deposit funded which salary · pool balances · how much any lane has left · who
                holds unspent notes. Deposits and exits are public by design — the link between them
                is what cryptography takes away.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ---------- final cta ---------- */}
      <section data-reveal className="mx-auto max-w-5xl px-4 pb-4 pt-10 sm:px-6">
        <Card className="card-lift bg-secondary/50">
          <CardContent className="flex flex-col items-center gap-5 pt-8 pb-8 text-center">
            <h2 className="h-display max-w-xl text-3xl sm:text-4xl">Ready to run a shielded payroll?</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              One signature for the whole run - none once the vault is funded. Employees claim
              gasless, with nothing but a regular wallet.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" className="group btn-glow" onClick={() => onRole("employer")}>
                Run payroll <ArrowRight className="ml-1 size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </Button>
              <Button size="lg" variant="outline" onClick={() => onRole("employee")}>
                I'm an employee
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <footer className="mx-auto max-w-5xl px-4 py-10 text-center text-xs text-muted-foreground sm:px-6">
        Runs against your configured Solana cluster and relayer — see Settings after signing in.
        Every number on this page is measured: 210-employee runs on a local validator, logged in{" "}
        <span className="mono">payroll/SPEED-JOURNEY.html</span>.
      </footer>
    </div>
  )
}
