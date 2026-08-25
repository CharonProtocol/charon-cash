import { ArrowRight, Building2, EyeOff, Timer, User } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const steps = [
  {
    n: "1",
    title: "Fund",
    body: "The treasury deposits one lump sum into the shielded pool. Public: the amount in. Hidden: everything after.",
  },
  {
    n: "2",
    title: "Split",
    body: "Funds are shielded to 16 pool wallets. On-chain this is just tree updates — no addresses, no amounts.",
  },
  {
    n: "3",
    title: "Pay",
    body: "Each pool pays its employees through zero-knowledge withdrawals. 210 people, ~4 minutes, zero retries.",
  },
  {
    n: "4",
    title: "Claim",
    body: "Employees see private notes in their wallet and claim to plain SOL whenever they want.",
  },
]

export function Landing({ onRole }: { onRole: (r: "employer" | "employee") => void }) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            P
          </div>
          <span className="text-lg font-semibold tracking-tight">Privacy Payroll</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => onRole("employee")}>
            Employee sign in
          </Button>
          <Button size="sm" onClick={() => onRole("employer")}>
            Employer sign in
          </Button>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 pb-4 pt-14 text-center">
        <Badge variant="secondary" className="mb-5">
          <EyeOff className="mr-1 size-3" /> shielded on solana
        </Badge>
        <h1 className="mx-auto max-w-2xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Pay your whole team.
          <br />
          <span className="text-primary">Prove nothing on-chain.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-muted-foreground">
          Run payroll from a Solana wallet with zero-knowledge proofs. An observer sees a deposit go
          in and salaries come out — but can never link the two, the amounts in between, or your
          company's remaining balance.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button size="lg" onClick={() => onRole("employer")}>
            Run payroll <ArrowRight className="ml-1 size-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => onRole("employee")}>
            I'm an employee
          </Button>
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl grid-cols-3 gap-3 px-6 py-10">
        {[
          { v: "210 / 210", l: "employees paid in the benchmark run" },
          { v: "~230s", l: "end to end — native prover, 16 parallel lanes" },
          { v: "0", l: "failed pays and retries across the run" },
        ].map((s) => (
          <Card key={s.v}>
            <CardContent className="pt-6 text-center">
              <div className="text-3xl font-semibold tabular-nums">{s.v}</div>
              <p className="mt-1 text-xs text-muted-foreground">{s.l}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mx-auto grid max-w-5xl gap-4 px-6 py-8 md:grid-cols-2">
        <Card className="border-primary/25 bg-secondary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="size-5 text-primary" /> For employers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Sign in with your treasury wallet and pay everyone from one screen:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>Upload a CSV of addresses and amounts, review the plan and fees</li>
              <li>Public mode or fully shielded notes (v2) per run</li>
              <li>Live progress, receipts, and one-click resume of failed rows</li>
            </ul>
            <Button className="mt-3 w-full" onClick={() => onRole("employer")}>
              Sign in as employer
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="size-5 text-primary" /> For employees
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

      <section className="mx-auto max-w-5xl px-6 py-8">
        <h2 className="mb-1 text-center text-2xl font-semibold tracking-tight">How it works</h2>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          Four stages, sixteen parallel lanes, one merkle tree.
        </p>
        <div className="grid gap-3 md:grid-cols-4">
          {steps.map((s) => (
            <Card key={s.n}>
              <CardContent className="pt-6">
                <div className="mb-2 flex size-7 items-center justify-center rounded-full bg-primary/10 font-mono text-sm font-semibold text-primary">
                  {s.n}
                </div>
                <div className="font-medium">{s.title}</div>
                <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 py-8">
        <Card className="bg-secondary/50">
          <CardContent className="flex flex-col items-center gap-4 pt-6 text-center sm:flex-row sm:text-left">
            <Timer className="size-8 flex-none text-primary" />
            <div>
              <p className="font-medium">What the chain never learns</p>
              <p className="mt-1 text-sm text-muted-foreground">
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
        Benchmark numbers from a localhost 210-employee run.
      </footer>
    </div>
  )
}
