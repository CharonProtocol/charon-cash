import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

type Item<T extends string> = { id: T; label: string; icon?: ReactNode }

/**
 * beUI Tabs: a pill tab group whose active indicator glides between tabs.
 * Pure DOM measurement + a CSS-transformed pill — no motion/react. Falls back
 * to a plain active-color swap under reduced motion (the pill still moves via
 * the .glider transition, which the reduced-motion block in index.css turns off).
 */
export function GliderGroup<T extends string>({
  items,
  value,
  onChange,
  className = "",
  itemClassName = "",
  pillClassName = "",
  tone = "default",
}: {
  items: Item<T>[]
  value: T
  onChange?: (id: T) => void
  className?: string
  itemClassName?: string
  pillClassName?: string
  /** "band" renders for the dark console band (band-ink text, band-2 pill) */
  tone?: "default" | "band"
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())
  const [pill, setPill] = useState<{ left: number; top: number; w: number; h: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const el = itemRefs.current.get(value)
      const c = containerRef.current
      if (!el || !c) return
      const er = el.getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      setPill({ left: er.left - cr.left, top: er.top - cr.top, w: er.width, h: er.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    const fonts = document.fonts?.ready
    fonts?.then(measure).catch(() => {})
    return () => ro.disconnect()
  }, [value])

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {pill && (
        <span
          aria-hidden
          className={`glider pointer-events-none absolute rounded-md ${pillClassName || "bg-card shadow-sm"}`}
          style={{ width: pill.w, height: pill.h, transform: `translate(${pill.left}px, ${pill.top}px)` }}
        />
      )}
      {items.map((it) => (
        <button
          key={it.id}
          ref={(el) => {
            if (el) itemRefs.current.set(it.id, el)
            else itemRefs.current.delete(it.id)
          }}
          onClick={() => onChange?.(it.id)}
          className={`relative z-10 flex items-center gap-2 rounded-md ${
            /(?:^|\s)px-/.test(itemClassName) ? "" : "px-3"
          } ${/(?:^|\s)py-/.test(itemClassName) ? "" : "py-2"} text-sm transition-colors ${
            tone === "band"
              ? value === it.id
                ? "text-band-ink"
                : "text-band-mute hover:text-band-ink"
              : value === it.id
                ? "text-ink"
                : "text-body-ink hover:text-ink"
          } ${itemClassName}`}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  )
}
