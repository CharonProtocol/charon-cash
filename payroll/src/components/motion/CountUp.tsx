import { useEffect, useRef, useState } from "react"

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * beUI-style count-up: the number ticks from 0 to its value the first time it
 * scrolls into view. Renders tabular figures so layouts never shift.
 */
export function CountUp({
  to,
  decimals = 0,
  duration = 1100,
  prefix = "",
  suffix = "",
  className,
}: {
  to: number
  decimals?: number
  duration?: number
  prefix?: string
  suffix?: string
  className?: string
}) {
  const staticMode = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("static")
  const ref = useRef<HTMLSpanElement>(null)
  const [val, setVal] = useState(reduced() || staticMode() || to === 0 ? to : 0)
  const started = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el || started.current) return
    if (reduced() || staticMode() || !("IntersectionObserver" in window)) {
      setVal(to)
      started.current = true
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          started.current = true
          io.disconnect()
          const t0 = performance.now()
          const tick = (t: number) => {
            const p = Math.min(1, (t - t0) / duration)
            // easeOutCubic
            const eased = 1 - Math.pow(1 - p, 3)
            setVal(to * eased)
            if (p < 1) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [to, duration])

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {val.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  )
}
