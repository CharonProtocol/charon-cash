import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { OPERATIONS, type Operation } from "../lib/operations";

export function GlassTabs({
  value,
  onChange,
  disabled = false,
}: {
  disabled?: boolean;
  value: Operation;
  onChange: (op: Operation) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(
    null,
  );
  const [animate, setAnimate] = useState(false);

  // Measure the active tab so the glass indicator can slide to it.
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[OPERATIONS.indexOf(value)];
      if (!el) return;
      setPill({ left: el.offsetLeft, width: el.offsetWidth });
      // Scroll only the pill itself. scrollIntoView() also scrolls every ancestor
      // (including the page), which is what made the whole page jump.
      const list = listRef.current;
      if (list && list.scrollWidth > list.clientWidth) {
        list.scrollTo({
          left: el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
        });
      }
    };
    measure();
    // Enable transitions only after the first measurement so it doesn't fly in from 0.
    const raf = requestAnimationFrame(() => setAnimate(true));
    const ro = new ResizeObserver(measure);
    refs.current.forEach((b) => b && ro.observe(b));
    if (listRef.current) ro.observe(listRef.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [value]);

  // Arrow-key navigation with roving tabindex (WAI-ARIA tabs pattern)
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (disabled) return;
    const last = OPERATIONS.length - 1;
    const next =
      e.key === "ArrowRight"
        ? i === last
          ? 0
          : i + 1
        : e.key === "ArrowLeft"
          ? i === 0
            ? last
            : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    onChange(OPERATIONS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="tabs-shell glass">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Operation"
        className="tab-list"
      >
        {/* Sliding glass indicator: flows between tabs */}
        {pill && (
          <span
            aria-hidden
            className={`indicator ${animate ? "animate" : ""}`}
            style={{ left: pill.left, width: pill.width }}
          />
        )}
        {OPERATIONS.map((op, i) => {
          const active = op === value;
          return (
            <button
              key={op}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              disabled={disabled}
              id={`tab-${i}`}
              aria-selected={active}
              aria-controls="op-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(op)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`tab-button ${active ? "active" : ""}`}
            >
              {op}
            </button>
          );
        })}
      </div>
    </div>
  );
}
