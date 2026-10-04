import { useRef, useState } from "react"
import { toast } from "sonner"
import { ClipboardPaste, FileUp, X } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { CountUp } from "@/components/motion/CountUp"
import { Ms } from "@/components/motion/ms"
import { Textarea } from "@/components/ui/textarea"
import { hashFileBytes, parsePayrollFile } from "@/lib/parse"
import { shortHash } from "@/lib/format"
import type { ParsedFile } from "@/lib/types"

// Controlled: parsed state lives in EmployerApp so the recipient ledger and
// this card can never disagree after a row removal.
export function UploadCard({
  parsed,
  onParsed,
}: {
  parsed: ParsedFile | null
  onParsed: (p: ParsedFile | null) => void
}) {
  const [errors, setErrors] = useState<string[]>([])
  const [paste, setPaste] = useState("")
  const [showPaste, setShowPaste] = useState(false)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const ingest = async (text: string, bytes?: Uint8Array) => {
    const r = parsePayrollFile(text)
    if (!r.ok) {
      setErrors(r.errors)
      onParsed(null)
      return
    }
    const fileHash = bytes
      ? await hashFileBytes(bytes)
      : await hashFileBytes(new TextEncoder().encode(text))
    const p: ParsedFile = { entries: r.entries, fileHash }
    setErrors([])
    onParsed(p)
    toast.success(`Parsed ${r.entries.length} payments`)
  }

  const ingestFile = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer())
    await ingest(new TextDecoder().decode(bytes), bytes)
  }

  const clear = () => {
    setErrors([])
    setPaste("")
    onParsed(null)
  }

  return (
    <Card className="card-lift specular h-fit">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="flex items-center gap-3">
          <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
            <Ms name="view_list" className="text-sm text-gold" />
          </span>
          <div>
            <CardTitle className="h-display text-base font-semibold tracking-tight">
              Batch Matrix Ingestion
            </CardTitle>
            <CardDescription className="mt-0.5 text-xs">
              CSV with header <code>address,amount,memo</code> or JSON{" "}
              <code>{"{ payments: [...] }"}</code> — amounts are what each employee receives.
            </CardDescription>
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <FileUp className="mr-1 size-3.5" /> CSV Schema
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowPaste((v) => !v)}
            className={showPaste ? "border border-line bg-panel-2" : ""}
          >
            <ClipboardPaste className="mr-1 size-3.5" /> Paste Text
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          ref={fileRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            if (!f) return
            await ingestFile(f)
            e.target.value = ""
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setDrag(false)
            const f = e.dataTransfer.files?.[0]
            if (f) await ingestFile(f)
          }}
          className={`group flex w-full cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center outline-none transition-all focus-visible:outline-none ${
            drag
              ? "scale-[1.01] border-gold bg-gold-soft"
              : "border-line hover:border-[color-mix(in_srgb,var(--gold-2)_45%,var(--border))] hover:bg-panel"
          }`}
        >
          <span className="flex size-14 items-center justify-center rounded-full border border-line bg-panel-2 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:scale-105">
            <Ms name="cloud_upload" className="text-lg text-gold" />
          </span>
          <span className="text-sm font-medium">
            Click to browse or drag and drop batch ledger
          </span>
          <span className="font-mono text-[11px] text-mute">
            Format: address, amount, memo &nbsp;(.csv · .json · up to 200 rows)
          </span>
          <span className="flex flex-wrap justify-center gap-1.5">
            <span className="tag tag--gold">
              <Ms name="account_tree" className="text-xs" /> Poseidon native proofs
            </span>
            <span className="tag tag--priv">
              <Ms name="enhanced_encryption" className="text-xs" /> ephemeral keys
            </span>
          </span>
        </button>
        {showPaste && (
          <div className="space-y-2">
            <Textarea
              placeholder="Paste JSON or CSV here…"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              className="font-mono text-xs"
            />
            <Button variant="outline" disabled={!paste.trim()} onClick={() => ingest(paste)}>
              Parse pasted text
            </Button>
          </div>
        )}
        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Batch rejected — fix and re-upload</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {errors.slice(0, 12).map((err, i) => (
                  <li key={i} className="font-mono text-xs">{err}</li>
                ))}
                {errors.length > 12 && <li>…and {errors.length - 12} more</li>}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {parsed && (
          <div className="flex items-center gap-3 rounded-xl border border-ok-line bg-ok-soft/60 px-3.5 py-3">
            <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-ok-line bg-card">
              <Ms name="check_circle" className="text-sm text-ok" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                batch file <span className="font-mono text-xs text-mute">{shortHash(parsed.fileHash, 6, 4)}</span>
              </div>
              <div className="text-xs text-body-ink">
                {parsed.entries.length} valid recipients (100% parsed)
              </div>
            </div>
            <span className="hidden rounded border border-ok-line bg-card px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-ok sm:inline">
              matrix validated
            </span>
            <button
              type="button"
              aria-label="Clear batch"
              onClick={clear}
              className="flex size-7 flex-none items-center justify-center rounded-md text-mute transition-colors hover:bg-card hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-mute">
              Recipients
            </div>
            <div className="stat-number mt-0.5 font-mono text-lg font-semibold tabular-nums">
              <CountUp to={parsed?.entries.length ?? 0} />
            </div>
          </div>
          <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-mute">
              Proofs
            </div>
            <div className="mt-0.5 truncate text-sm font-medium text-body-ink">
              Groth16 · 1 / payout
            </div>
          </div>
          <div className="rounded-xl border border-line bg-panel px-3 py-2.5">
            <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-mute">
              Worker gas
            </div>
            <div className="mt-0.5 text-sm font-medium text-body-ink">
              <span className="font-mono">0</span> SOL · subsidized
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
