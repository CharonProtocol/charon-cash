import { cn } from "@/lib/utils"

export function JsonBlock({
  value,
  className,
}: {
  value: unknown
  className?: string
}) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return (
    <pre
      className={cn(
        "max-h-80 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-foreground",
        className,
      )}
    >
      <code className="font-mono whitespace-pre-wrap break-all">{text}</code>
    </pre>
  )
}

export function ErrorBlock({
  code,
  message,
}: {
  code: string
  message: string
}) {
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <span className="font-mono font-semibold text-destructive">{code}</span>
      <p className="mt-1 break-words text-destructive/90">{message}</p>
    </div>
  )
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        ok ? "bg-green-500" : "bg-red-500",
      )}
    />
  )
}
