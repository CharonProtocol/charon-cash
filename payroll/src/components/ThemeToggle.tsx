import { Moon, Sun } from "lucide-react"

import { useTheme } from "@/hooks/useTheme"

export function ThemeToggle({ band = false }: { band?: boolean }) {
  const { theme, toggle } = useTheme()
  const onClick = () => {
    // beUI-style theme repaint: a circular clip reveal through the View
    // Transition API where supported, plain swap otherwise.
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (!doc.startViewTransition || reduced) {
      toggle()
      return
    }
    doc.startViewTransition(() => toggle())
  }
  return (
    <button
      type="button"
      aria-label="Toggle theme"
      onClick={onClick}
      className={
        band
          ? "flex size-8 items-center justify-center rounded-lg border border-band-line bg-band-2 text-band-mute transition-colors hover:text-band-ink"
          : "flex size-8 items-center justify-center rounded-lg border border-border bg-panel text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground"
      }
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  )
}
