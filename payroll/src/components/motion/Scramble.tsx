import { useEffect, useRef, useState } from "react"

const DEFAULT_GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&@$?/"

/**
 * beUI Text Scramble, ported without motion/react: resolves changed text
 * left-to-right while unresolved positions cycle through `glyphs`. Runs once
 * on mount; reduced motion renders the final text directly.
 */
export function Scramble({
  text,
  duration,
  glyphs = DEFAULT_GLYPHS,
  className,
}: {
  text: string
  /** max animation duration in ms (default clamp(420, len*32, 760)) */
  duration?: number
  glyphs?: string
  className?: string
}) {
  const reduce = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const staticMode = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("static")
  const [display, setDisplay] = useState(() => (reduce() || staticMode() ? text : text.replace(/\S/g, glyphs[0])))
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
    }
    if (reduce() || staticMode() || !glyphs) {
      setDisplay(text)
      return
    }
    const characters = text.split("")
    const startedAt = performance.now()
    const animationDuration =
      duration ?? Math.min(760, Math.max(420, characters.length * 32))
    let frame = 0
    let lastUpdate = 0

    const animate = (now: number) => {
      if (now - lastUpdate >= 40) {
        lastUpdate = now
        const progress = Math.min((now - startedAt) / animationDuration, 1)
        const settled = Math.floor(progress * characters.length)
        setDisplay(
          characters
            .map((character, index) => {
              if (index < settled || character === " ") return character
              return glyphs[Math.floor(Math.random() * glyphs.length)]
            })
            .join(""),
        )
      }
      if (now - startedAt < animationDuration) {
        frame = requestAnimationFrame(animate)
      } else {
        setDisplay(text)
      }
    }

    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [duration, glyphs, text])

  return (
    <span className="inline-block whitespace-pre" style={{ fontVariantNumeric: "tabular-nums" }}>
      <span className={className}>{display}</span>
    </span>
  )
}
