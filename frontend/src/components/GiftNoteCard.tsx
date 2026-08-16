import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ArrowDownToLine, Check, Copy, Gift } from "lucide-react"

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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

// Pack a single note as a compact, shareable payment code (base64 of [note]).
// Note fields are ASCII (hex / numbers / base58), so btoa is binary-safe here.
function encodePaymentNote(note: Note): string {
  return btoa(JSON.stringify([note]))
}

// Accept either a base64 payment code OR raw JSON (one note or an array).
function decodePaymentNotes(code: string): Note[] {
  const trimmed = code.trim()
  try {
    const p = JSON.parse(trimmed)
    if (Array.isArray(p)) return p as Note[]
    if (p && typeof p === "object") return [p as Note]
  } catch {
    /* not raw JSON — try base64 below */
  }
  const json = atob(trimmed.replace(/\s/g, ""))
  const p = JSON.parse(json)
  if (Array.isArray(p)) return p as Note[]
  if (p && typeof p === "object") return [p as Note]
  throw new Error("Could not parse a payment note from the input")
}

export function GiftNoteCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected, publicKey } = usePrivacyCash()
  const [mode, setMode] = useState<"generate" | "redeem">("generate")
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [redeemInput, setRedeemInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = () =>
    setNotes(publicKey ? loadNotes(publicKey).filter((n) => !n.spent) : [])

  useEffect(() => {
    load()
    setSelectedId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey])

  const selected = notes.find((n) => n.id === selectedId) ?? null
  const paymentCode = useMemo(
    () => (selected ? encodePaymentNote(selected) : ""),
    [selected],
  )

  const copyCode = async () => {
    if (!paymentCode) return
    try {
      await navigator.clipboard?.writeText(paymentCode)
      setCopied(true)
      toast.success("Payment code copied")
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Copy failed")
    }
  }

  const redeem = async () => {
    if (!client) return
    setBusy(true)
    try {
      const parsed = decodePaymentNotes(redeemInput)
      const n = await client.importNotesJson(JSON.stringify(parsed))
      setRedeemInput("")
      onChanged?.()
      load()
      toast.success(
        `Redeemed ${n} note${n === 1 ? "" : "s"} — spend it from Private Withdraw anytime`,
      )
    } catch (e) {
      toast.error(`Redeem failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="size-4" /> Send / redeem a payment note
        </CardTitle>
        <CardDescription>
          Generate a private payment note from one of your unspent notes and
          share the code with anyone. They redeem it here and withdraw it on
          their own wallet whenever they like — the handoff leaves no on-chain
          link back to you. Unlike Private Transfer (which lands public SOL at an
          address instantly), this hands off a spendable note for the recipient
          to spend later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet to send or redeem a note.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex w-fit items-center gap-1 rounded-lg border border-border bg-secondary p-0.5">
          {(["generate", "redeem"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m === "generate" ? "Generate" : "Redeem"}
            </button>
          ))}
        </div>

        {mode === "generate" ? (
          <>
            <Alert>
              <AlertTitle>Bearer note — share carefully</AlertTitle>
              <AlertDescription>
                Anyone holding this code can spend the note. It stays spendable
                from your own wallet too until it is actually withdrawn, so treat
                the code like cash and share it only with your intended
                recipient.
              </AlertDescription>
            </Alert>

            {notes.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No unspent notes in memory. Deposit, or load your vault, then
                come back here.
              </p>
            ) : (
              <div className="space-y-2">
                <Label>Pick an unspent note to send</Label>
                <div className="max-h-64 space-y-2 overflow-auto rounded-xl border border-border p-2">
                  {notes.map((n) => {
                    const isSol = n.mintAddress === WRAPPED_SOL_MINT
                    const amountLabel = isSol
                      ? `${lamportsToSol(Number(n.amount)).toFixed(6)} SOL`
                      : `${n.amount} raw`
                    return (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => setSelectedId(n.id)}
                        className={`flex w-full flex-col gap-1 rounded-lg border bg-card p-3 text-left transition-colors sm:flex-row sm:items-center sm:justify-between ${
                          selectedId === n.id
                            ? "border-primary"
                            : "border-border hover:border-primary/30"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-medium text-foreground">
                            {amountLabel}
                          </span>
                          <Badge variant="outline">
                            {isSol ? "SOL" : shortHash(n.mintAddress, 4, 4)}
                          </Badge>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            leaf {n.index}
                          </span>
                        </div>
                        {selectedId === n.id && (
                          <Check className="size-4 text-primary" />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {paymentCode && (
              <div className="space-y-1.5">
                <Label>Payment code — send this to the recipient</Label>
                <Textarea
                  readOnly
                  value={paymentCode}
                  rows={4}
                  className="break-all font-mono text-[11px]"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={copyCode}
                  disabled={!connected}
                >
                  {copied ? (
                    <Check className="mr-1.5 size-3.5" />
                  ) : (
                    <Copy className="mr-1.5 size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <Alert>
              <AlertTitle>Redeem a note you received</AlertTitle>
              <AlertDescription>
                Paste a payment code (or raw note JSON). The note is added to
                your vault and persisted to your encrypted backend backup —
                spend it from the Private Withdraw tab whenever you want. You may
                need to approve a signature first.
              </AlertDescription>
            </Alert>
            <div className="space-y-1.5">
              <Label htmlFor="redeem">Payment code or note JSON</Label>
              <Textarea
                id="redeem"
                value={redeemInput}
                onChange={(e) => setRedeemInput(e.target.value)}
                placeholder="paste the payment code you received…"
                rows={4}
                className="break-all font-mono text-[11px]"
                disabled={!connected || busy}
              />
              <Button
                onClick={redeem}
                disabled={!connected || !client || busy || !redeemInput.trim()}
                className="w-full"
              >
                <ArrowDownToLine className="mr-1.5 size-4" />
                {busy ? "Redeeming…" : "Redeem note"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
