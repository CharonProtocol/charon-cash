import { useRef, type ReactNode } from "react"

/**
 * beUI MagneticButton feel, CSS-only: the wrapper leans toward the cursor by
 * up to `strength` px while hovered (via --mx/--my consumed by .magnetic).
 * No-op on touch devices and for reduced motion.
 */
export function Magnetic({
  children,
  strength = 4,
}: {
  children: ReactNode
  strength?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current
    if (!el) return
    if (!window.matchMedia("(hover: hover)").matches) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const r = el.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    el.style.setProperty("--mx", `${(dx / (r.width / 2)) * strength}px`)
    el.style.setProperty("--my", `${(dy / (r.height / 2)) * strength}px`)
  }
  const onLeave = () => {
    ref.current?.style.setProperty("--mx", "0px")
    ref.current?.style.setProperty("--my", "0px")
  }

  return (
    <span ref={ref} className={`magnetic inline-flex`} onMouseMove={onMove} onMouseLeave={onLeave}>
      {children}
    </span>
  )
}
