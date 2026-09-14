import { useRef, useState } from "react"
import { toast } from "sonner"
import { ClipboardPaste, FileUp } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { hashFileBytes, parsePayrollFile } from "@/lib/parse"
import { shortHash } from "@/lib/format"
import type { ParsedFile } from "@/lib/types"

export function UploadCard({ onParsed }: { onParsed: (p: ParsedFile | null) => void }) {
  const [errors, setErrors] = useState<string[]>([])
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [paste, setPaste] = useState("")
  const [showPaste, setShowPaste] = useState(false)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const ingest = async (text: string, bytes?: Uint8Array) => {
    const r = parsePayrollFile(text)
    if (!r.ok) {
      setParsed(null)
      setErrors(r.errors)
      onParsed(null)
      return
    }
    const fileHash = bytes
      ? await hashFileBytes(bytes)
      : await hashFileBytes(new TextEncoder().encode(text))
    const p: ParsedFile = { entries: r.entries, fileHash }
    setErrors([])
    setParsed(p)
    onParsed(p)
    toast.success(`Parsed ${r.entries.length} payments`)
  }

  const ingestFile = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer())
    await ingest(new TextDecoder().decode(bytes), bytes)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp className="size-4" /> Upload payroll file
        </CardTitle>
        <CardDescription>
          JSON <code>{"{ payments: [{ address, amount, memo }] }"}</code> or CSV with header
          <code> address,amount,memo</code>. Amounts are what each employee receives.
        </CardDescription>
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
          className={`flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-9 text-center transition-all ${
            drag
              ? "border-primary bg-primary/10 shadow-[0_0_40px_-10px] shadow-primary/60"
              : "border-border hover:border-primary/50 hover:bg-secondary/50"
          }`}
        >
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <FileUp className="size-5 text-primary" />
          </div>
          <span className="text-sm font-medium">Drop your payroll file here</span>
          <span className="text-xs text-muted-foreground">
            or click to browse — CSV / JSON, up to 200 rows
          </span>
        </button>
        {!showPaste ? (
          <Button variant="ghost" size="sm" onClick={() => setShowPaste(true)}>
            <ClipboardPaste className="mr-1 size-3.5" /> or paste text instead
          </Button>
        ) : (
          <>
            <Textarea
              placeholder="Paste JSON or CSV here…"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              className="font-mono text-xs"
            />
            <Button variant="outline" disabled={!paste.trim()} onClick={() => ingest(paste)}>
              Parse pasted text
            </Button>
          </>
        )}
        {errors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>File rejected — fix and re-upload</AlertTitle>
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
          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>{parsed.entries.length} payments · file {shortHash(parsed.fileHash, 6, 4)}</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-3 py-1.5 font-medium">#</th>
                    <th className="px-3 py-1.5 font-medium">Address</th>
                    <th className="px-3 py-1.5 font-medium text-right">Amount</th>
                    <th className="px-3 py-1.5 font-medium">Memo</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.entries.map((e, i) => (
                    <tr key={e.address} className="border-t">
                      <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono">{shortHash(e.address, 6, 4)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{e.amountHuman}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{e.memo ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
