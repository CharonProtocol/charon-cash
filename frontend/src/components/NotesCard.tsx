import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Check, Copy, KeyRound, RefreshCw } from "lucide-react"

import { lamportsToSol, shortHash } from "@/lib/format"
import { loadNotes, WRAPPED_SOL_MINT, type Note } from "privacy-cash-sdk"
import { usePrivacyCash } from "@/hooks/usePrivacyCash"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(text)
          setDone(true)
          toast.success(label ?? "Copied")
          setTimeout(() => setDone(false), 1500)
        } catch {
          toast.error("Copy failed")
        }
      }}
    >
      {done ? <Check className="size-3" /> : <Copy className="size-3" />}
      {done ? "copied" : "copy"}
    </Button>
  )
}

export function NotesCard({ refreshKey }: { refreshKey: number }) {
  const { client, publicKey } = usePrivacyCash()
  const [paste, setPaste] = useState("")
  const [notes, setNotes] = useState<Note[]>([])
  const [tick, setTick] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [filter, setFilter] = useState<"all" | "unspent" | "spent">("all")

  const reload = () => {
    setSpinning(true)
    setTick((t) => t + 1)
    window.setTimeout(() => setSpinning(false), 450)
  }

  // Load notes straight from the SDK's in-memory cache (decrypted; never on disk).
  const load = () => setNotes(publicKey ? loadNotes(publicKey) : [])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, refreshKey, tick])

  // Pull + decrypt the encrypted backend blob into memory (needs a signature).
  const refresh = async () => {
    if (!client) return
    setSpinning(true)
    try {
      await client.refreshNotes()
      reload()
    } catch (e) {
      toast.error(`Load failed: ${(e as Error).message}`)
    } finally {
      setSpinning(false)
    }
  }

  const unspent = notes.filter((n) => !n.spent)
  const spent = notes.filter((n) => n.spent)
  const visible =
    filter === "all" ? notes : filter === "unspent" ? unspent : spent

  const solBalance = unspent
    .filter((n) => n.mintAddress === WRAPPED_SOL_MINT)
    .reduce((s, n) => s + BigInt(n.amount), 0n)
  const splBalances = new Map<string, bigint>()
  for (const n of unspent) {
    if (n.mintAddress === WRAPPED_SOL_MINT) continue
    splBalances.set(
      n.mintAddress,
      (splBalances.get(n.mintAddress) ?? 0n) + BigInt(n.amount),
    )
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-4" /> Notes &amp; balance
            </CardTitle>
            <CardDescription className="mt-1.5">
              Notes are stored <strong className="font-medium text-foreground">only</strong> as an
              encrypted blob on the backend (the server can&apos;t read them). Nothing sensitive is
              kept in this browser — decrypted notes exist only in memory after you unlock. Click
              load and approve the signature to fetch them.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={!client || spinning}
            className="shrink-0"
          >
            <RefreshCw className={`mr-1.5 size-3.5 ${spinning ? "animate-spin" : ""}`} />
            Load notes
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-secondary/50 p-4">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              Private SOL
            </p>
            <p className="h-display mt-1 text-3xl text-foreground">
              {lamportsToSol(Number(solBalance)).toFixed(6)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">SOL</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {unspent.filter((n) => n.mintAddress === WRAPPED_SOL_MINT).length} unspent note
              {unspent.filter((n) => n.mintAddress === WRAPPED_SOL_MINT).length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-secondary/50 p-4">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              Private SPL
            </p>
            {splBalances.size === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No SPL notes yet</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {[...splBalances.entries()].map(([mint, bal]) => (
                  <li
                    key={mint}
                    className="flex items-center justify-between gap-2 font-mono text-xs"
                  >
                    <span className="text-foreground">{bal.toString()} raw</span>
                    <span className="text-muted-foreground">{shortHash(mint, 6, 4)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary p-0.5">
              {(
                [
                  ["all", `All (${notes.length})`],
                  ["unspent", `Unspent (${unspent.length})`],
                  ["spent", `Spent (${spent.length})`],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    filter === id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {publicKey && notes.length > 0 && client && (
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(client.exportNotesString())
                    toast.success("Notes JSON copied")
                  }}
                >
                  Export
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={async () => {
                    if (!confirm("Delete all notes for this wallet (memory + encrypted backup)?"))
                      return
                    try {
                      await client.clearAllNotes()
                      reload()
                      toast.message("Notes cleared")
                    } catch (e) {
                      toast.error(`Clear failed: ${(e as Error).message}`)
                    }
                  }}
                >
                  Clear
                </Button>
              </div>
            )}
          </div>

          <div className="max-h-72 space-y-2 overflow-auto rounded-xl border border-border p-2">
            {visible.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                {notes.length === 0
                  ? "No notes in memory — click “Load notes” and approve the signature to fetch your encrypted notes, or deposit to create one."
                  : `No ${filter} notes.`}
              </p>
            )}
            {visible.map((n) => {
              const isSol = n.mintAddress === WRAPPED_SOL_MINT
              const amountLabel = isSol
                ? `${lamportsToSol(Number(n.amount)).toFixed(6)} SOL`
                : `${n.amount} raw`
              return (
                <div
                  key={n.id}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/30 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-medium text-foreground">
                        {amountLabel}
                      </span>
                      <Badge variant={n.spent ? "secondary" : "outline"}>
                        {n.spent ? "spent" : "unspent"}
                      </Badge>
                      {!isSol && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          mint {shortHash(n.mintAddress, 4, 4)}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
                      <span>leaf {n.index}</span>
                      {n.depositTx && (
                        <span title={n.depositTx}>tx {shortHash(n.depositTx, 6, 4)}</span>
                      )}
                      <span title={n.id}>id {shortHash(n.id, 4, 4)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {n.depositTx && <CopyBtn text={n.depositTx} label="Tx signature copied" />}
                    <CopyBtn
                      text={JSON.stringify(n, null, 2)}
                      label="Note JSON copied"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-1.5 rounded-xl border border-dashed border-border p-3">
          <Label htmlFor="import">Import notes JSON</Label>
          <Textarea
            id="import"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder='[ { "amount": "...", "blinding": "...", "index": 0, ... } ]'
            className="font-mono text-xs"
            rows={3}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={!client || !paste}
            onClick={async () => {
              if (!client) return
              try {
                const n = await client.importNotesJson(paste)
                setPaste("")
                reload()
                toast.success(`Imported ${n} notes`)
              } catch (e) {
                toast.error(`Import failed: ${(e as Error).message}`)
              }
            }}
          >
            Import
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
