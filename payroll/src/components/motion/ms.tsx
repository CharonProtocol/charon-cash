import { cn } from "@/lib/utils"

/**
 * Material Symbols icon (the reference design's icon set), rendered via the
 * Google Fonts ligature stylesheet loaded in index.html.
 */
export function Ms({
  name,
  className,
  fill = false,
}: {
  name: string
  className?: string
  fill?: boolean
}) {
  return (
    <span
      aria-hidden
      translate="no"
      className={cn("ms-icon", className)}
      style={fill ? { fontVariationSettings: "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 20" } : undefined}
    >
      {name}
    </span>
  )
}
