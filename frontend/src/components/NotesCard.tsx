import { useEffect, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { KeyRound, RefreshCw } from "lucide-react"

import { lamportsToSol, shortHash } from "@/lib/format"
import {
  exportNotes,
  importNotes,
  loadNotes,
  clearNotes,
  type Note,
} from "@/lib/client-sdk"
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

export function NotesCard({ refreshKey }: { refreshKey: number }) {
  const { publicKey } = useWallet()
  const [paste, setPaste] = useState("")
  const [notes, setNotes] = useState<Note[]>([])
  const [tick, setTick] = useState(0)

  const reload = () => setTick((t) => t + 1)

  useEffect(() => {
    if (publicKey) setNotes(loadNotes(publicKey))
    else setNotes([])
  }, [publicKey, refreshKey, tick])

  const balance = notes
    .filter((n) => !n.spent)
    .reduce((s, n) => s + BigInt(n.amount), 0n)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" /> Notes &amp; balance
        </CardTitle>
        <CardDescription>
          Spendable notes are stored locally in your browser (per wallet).
          There is no backend UTXO discovery — keep a backup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">private balance</p>
            <p className="text-2xl font-semibold">
              {lamportsToSol(Number(balance)).toFixed(6)}{" "}
              <span className="text-sm text-muted-foreground">SOL</span>
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="mr-1 size-3" /> refresh
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>notes ({notes.length})</Label>
            {publicKey && notes.length > 0 && (
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(exportNotes(publicKey))
                  }}
                >
                  export
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm("Delete all local notes?")) {
                      clearNotes(publicKey)
                      reload()
                    }
                  }}
                >
                  clear
                </Button>
              </div>
            )}
          </div>
          <div className="max-h-48 space-y-1 overflow-auto rounded-md border p-2 text-xs">
            {notes.length === 0 && (
              <p className="text-muted-foreground">no notes yet — deposit to create one.</p>
            )}
            {notes.map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between gap-2 border-b pb-1 last:border-0"
              >
                <span className="font-mono">
                  {lamportsToSol(Number(n.amount)).toFixed(6)} SOL
                </span>
                <span className="text-muted-foreground">leaf {n.index}</span>
                {n.depositTx && (
                  <span className="text-muted-foreground">
                    {shortHash(n.depositTx, 6, 4)}
                  </span>
                )}
                <Badge variant={n.spent ? "secondary" : "outline"}>
                  {n.spent ? "spent" : "unspent"}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="import">import notes JSON</Label>
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
            disabled={!publicKey || !paste}
            onClick={() => {
              if (!publicKey) return
              try {
                const n = importNotes(publicKey, paste)
                setPaste("")
                reload()
                alert(`imported ${n} notes`)
              } catch (e) {
                alert(`import failed: ${(e as Error).message}`)
              }
            }}
          >
            import
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
