import { useEffect, useRef, useState } from "react"

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * beUI-style count-up: the number ticks from 0 to its value the first time it
 * scrolls into view, then glides to any new target (live vault balances, plan
 * totals) instead of freezing. Renders tabular figures so layouts never shift.
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
  const frame = useRef(0)
  const shown = useRef(reduced() || staticMode() || to === 0 ? to : 0)
  // keep the latest target visible inside long-running rAF callbacks
  const toRef = useRef(to)
  toRef.current = to

  const glide = (from: number, toV: number, ms: number) => {
    cancelAnimationFrame(frame.current)
    const t0 = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms)
      // easeOutCubic
      const eased = 1 - Math.pow(1 - p, 3)
      const v = from + (toV - from) * eased
      shown.current = v
      setVal(v)
      if (p < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
  }

  // first paint: wait for the element to scroll into view, then count from 0
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
          glide(0, toRef.current, duration)
        }
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      cancelAnimationFrame(frame.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // live targets: glide from the currently displayed value (duration is a
  // first-run hint; updates use a shorter, less intrusive sweep)
  useEffect(() => {
    if (!started.current || reduced() || staticMode()) {
      shown.current = to
      setVal(to)
      return
    }
    glide(shown.current, to, Math.min(500, duration))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to])

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {val.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  )
}
