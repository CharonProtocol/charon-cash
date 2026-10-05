import { motion, useTransform, type MotionValue } from "motion/react"

import { useSmoothScroll } from "@/components/motion/smooth-scroll"

const TICKS = 24
// every 4th tick is a longer major graduation — reads like a real ruler
const MAJOR_EVERY = 4

/**
 * beUI-style scroll ruler: a fixed strip of graduation ticks along the left
 * edge. Minor ticks sit short, every few ticks runs a longer major line, and
 * ticks fill gold as the page scrolls (driven by the smooth-scroll progress,
 * with a native-scroll fallback) — replacing the browser scrollbar.
 */
export function ScrollRuler() {
  const { progress } = useSmoothScroll()
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed left-2 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-start gap-2 md:flex"
    >
      {Array.from({ length: TICKS }, (_, i) => (
        <Tick key={i} index={i} progress={progress} />
      ))}
    </div>
  )
}

function Tick({ index, progress }: { index: number; progress: MotionValue<number> }) {
  // each tick lights up as progress crosses its slice of the page
  const threshold = index / (TICKS - 1)
  const filled = useTransform(progress, [threshold - 1 / TICKS, threshold], [0, 1])
  const major = index % MAJOR_EVERY === 0
  const width = useTransform(filled, [0, 1], major ? ["18px", "34px"] : ["10px", "20px"])
  const opacity = useTransform(filled, [0, 1], [major ? 0.4 : 0.25, 1])
  const bg = useTransform(filled, [0, 1], ["var(--ink)", "var(--gold)"])
  return (
    <motion.span
      className={major ? "h-[2px] rounded-full" : "h-px rounded-full"}
      style={{ width, opacity, backgroundColor: bg }}
    />
  )
}

/** Thin gold progress hairline pinned to the bottom edge of the console nav. */
export function ScrollProgress() {
  const { progress } = useSmoothScroll()
  const scaleX = useTransform(progress, [0, 1], [0.001, 1])
  return (
    <motion.div
      aria-hidden
      className="absolute inset-x-0 bottom-0 h-[2px] origin-left bg-gradient-to-r from-gold/60 via-gold to-gold"
      style={{ scaleX }}
    />
  )
}
