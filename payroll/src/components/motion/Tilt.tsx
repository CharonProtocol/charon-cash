import { useRef, type ReactNode } from "react"

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * beUI-style tilt card: subtle 3D perspective + cursor-tracked glare on hover.
 * Pure presentation — children stay interactive.
 */
export function Tilt({
  children,
  className,
  max = 3,
}: {
  children: ReactNode
  className?: string
  max?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const glare = useRef<HTMLDivElement>(null)

  const onMove = (e: React.MouseEvent) => {
    const el = ref.current
    if (!el || reduced()) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    el.style.transform = `perspective(1100px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg)`
    if (glare.current)
      glare.current.style.background = `radial-gradient(circle at ${px * 100}% ${py * 100}%, var(--glow), transparent 55%)`
  }
  const onLeave = () => {
    const el = ref.current
    if (el) el.style.transform = ""
    if (glare.current) glare.current.style.background = "transparent"
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={`relative transition-transform duration-300 ease-out will-change-transform ${className ?? ""}`}
    >
      <div
        ref={glare}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] transition-colors duration-300"
      />
      {children}
    </div>
  )
}
