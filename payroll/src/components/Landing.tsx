import {
  ArrowRight,
  Building2,
  EyeOff,
  Gauge,
  ShieldCheck,
  Timer,
  User,
  Users,
  Zap,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ThemeToggle } from "@/components/ThemeToggle"

const stats = [
  { v: "902s → 67.6s", l: "to pay 210 salaries — day one vs today, standard circuit", icon: Timer },
  { v: "13×", l: "faster, on the same 8 GB laptop", icon: Gauge },
  { v: "210 / 210", l: "paid exact — unequal salaries, 0 failures", icon: Users },
  { v: "1", l: "wallet signature for the whole run (0 when the vault is funded)", icon: Zap },
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

export function Landing({ onRole }: { onRole: (r: "employer" | "employee") => void }) {
  return (
    <div className="relative min-h-dvh">
      <div className="aurora" aria-hidden>
        <div className="grid-lines" />
      </div>

      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            P
          </div>
          <span className="h-display text-lg">Privacy Payroll</span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={() => onRole("employee")}>
            Employee sign in
          </Button>
          <Button size="sm" className="btn-glow" onClick={() => onRole("employer")}>
            Employer sign in
          </Button>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 pb-6 pt-16 text-center">
        <Badge
          variant="secondary"
          className="anim anim-1 mb-6 rounded-full border-emerald-200 bg-emerald-50 px-3.5 py-1.5 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
        >
          <EyeOff className="mr-1 size-3" /> zero-knowledge payroll · solana
        </Badge>
        <h1 className="h-display anim anim-2 mx-auto max-w-3xl text-5xl leading-[1.05] sm:text-6xl">
          Pay your whole team.
          <br />
          <span className="text-gradient">Prove nothing on-chain.</span>
        </h1>
        <p className="anim anim-3 mx-auto mt-6 max-w-xl text-pretty text-lg text-muted-foreground">
          Run payroll from a Solana wallet with zero-knowledge proofs. An observer sees a deposit go
          in and salaries come out — but can never link the two, the amounts in between, or your
          company's remaining balance.
        </p>
        <div className="anim anim-4 mt-9 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" className="btn-glow" onClick={() => onRole("employer")}>
            Run payroll <ArrowRight className="ml-1 size-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => onRole("employee")}>
            I'm an employee
          </Button>
        </div>

        {/* hero product widget — what the treasurer's screen actually looks like */}
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
            <div className="mt-5 flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Payout mode</span>
              <span className="flex gap-1 rounded-md border p-0.5 font-medium">
                <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">Public</span>
                <span className="rounded-md bg-primary px-2 py-0.5 text-xs text-primary-foreground">Private notes</span>
              </span>
            </div>
            <Button className="btn-glow mt-4 w-full" onClick={() => onRole("employer")}>
              Pay 5 employees now <ArrowRight className="ml-1 size-4" />
            </Button>
            <p className="mt-3 text-center text-[11px] text-muted-foreground">
              proofs built in your browser · payouts signed by the relayer · employees need zero SOL
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="anim anim-6 mx-auto grid max-w-5xl grid-cols-2 gap-3 px-6 py-12 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.v} className="card-lift">
            <CardContent className="pt-6">
              <s.icon className="mb-3 size-4 text-emerald-600 dark:text-emerald-400" />
              <div className="stat-number text-2xl font-bold sm:text-[1.7rem]">{s.v}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.l}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 py-8 md:grid-cols-2">
        <Card className="card-lift bg-secondary/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="size-5 text-emerald-600 dark:text-emerald-400" /> For employers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Sign in with your treasury wallet and pay everyone from one screen:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>Upload a CSV of addresses and amounts, review the plan and fees</li>
              <li>Public mode or fully shielded notes (v2) per run</li>
              <li>Live progress, receipts, and one-click resume of failed rows</li>
            </ul>
            <Button className="btn-glow mt-3 w-full" onClick={() => onRole("employer")}>
              Sign in as employer
            </Button>
          </CardContent>
        </Card>
        <Card className="card-lift">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-5 text-emerald-600 dark:text-emerald-400" /> For employees
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Your regular wallet is all you need:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>One-time toggle to receive private notes instead of public transfers</li>
              <li>See every payment that's yours — amounts hidden from everyone else</li>
              <li>Claim notes to your public balance whenever you like</li>
            </ul>
            <Button className="mt-3 w-full" variant="outline" onClick={() => onRole("employee")}>
              Sign in as employee
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-10">
        <h2 className="h-display mb-1 text-center text-3xl">How it works</h2>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          Four stages, sixteen parallel lanes, one merkle tree.
        </p>
        <div className="relative grid gap-3 md:grid-cols-4">
          <div
            aria-hidden
            className="absolute left-0 right-0 top-7 hidden h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent md:block"
          />
          {steps.map((s) => (
            <Card key={s.n} className="card-lift relative">
              <CardContent className="pt-6">
                <div className="relative z-10 mb-3 flex size-9 items-center justify-center rounded-full border border-zinc-300 bg-background font-mono text-sm font-semibold text-primary">
                  {s.n}
                </div>
                <div className="font-medium">{s.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-8">
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

      <footer className="mx-auto max-w-5xl px-6 py-10 text-center text-xs text-muted-foreground">
        Runs against your configured Solana cluster and relayer — see Settings after signing in.
        Every number on this page is measured: 210-employee runs on a local validator, logged in{" "}
        <span className="mono">payroll/SPEED-JOURNEY.html</span>.
      </footer>
    </div>
  )
}
