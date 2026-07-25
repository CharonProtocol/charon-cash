import { useState, type FormEvent } from "react"
import { ShieldAlert, Lock, ArrowRight, LogOut } from "lucide-react"
import { verifyOperator, setOperatorPassword } from "@privacy-cash/client"

import { AdminCard } from "@/components/AdminCard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function AdminView({ onChanged }: { onChanged: () => void }) {
  // In-memory only: the password is verified against the backend and held for
  // this tab's operator calls. A reload re-prompts.
  const [unlocked, setUnlocked] = useState(false)
  const [pwd, setPwd] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(false)
    const ok = await verifyOperator(pwd)
    setBusy(false)
    if (ok) {
      setOperatorPassword(pwd)
      setUnlocked(true)
      setPwd("")
    } else {
      setError(true)
    }
  }

  const lock = () => {
    setOperatorPassword(null)
    setUnlocked(false)
    setPwd("")
  }

  if (!unlocked) {
    return (
      <div className="mx-auto max-w-md py-10">
        <form
          onSubmit={submit}
          className="space-y-4 rounded-[14px] border border-border bg-card p-6 shadow-sm"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
              <Lock className="size-5" />
            </div>
            <div>
              <h2 className="h-display text-xl text-foreground">Operator console locked</h2>
              <p className="text-xs text-muted-foreground">
                Enter the operator password to continue.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="op-pwd">Operator password</Label>
            <Input
              id="op-pwd"
              type="password"
              value={pwd}
              onChange={(e) => {
                setPwd(e.target.value)
                setError(false)
              }}
              autoFocus
              autoComplete="current-password"
              disabled={busy}
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">
              Wrong password — or the backend has no{" "}
              <code className="font-mono">ADMIN_PASSWORD</code> set.
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy || !pwd}>
            {busy ? (
              "Verifying…"
            ) : (
              <>
                Unlock <ArrowRight className="ml-1 size-4" />
              </>
            )}
          </Button>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Checked against the backend&rsquo;s{" "}
            <code className="font-mono">ADMIN_PASSWORD</code> env var and held only in
            memory for this tab.
          </p>
        </form>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-4">
      <div className="space-y-3 rounded-[14px] border border-destructive/30 bg-destructive/5 p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive">
              <ShieldAlert className="size-6" />
            </div>
            <div>
              <h2 className="h-display text-xl text-destructive">Operator console</h2>
              <p className="text-xs text-muted-foreground">
                Restricted · program configuration &amp; tree initialization
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={lock} title="Lock console">
            <LogOut className="mr-1 size-3.5" /> Lock
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Operators initialize Merkle trees, set fee rates, and configure deposit
          limits. Standard users should use the Privacy Cash app.
        </p>
      </div>

      <AdminCard onChanged={onChanged} />
    </div>
  )
}
