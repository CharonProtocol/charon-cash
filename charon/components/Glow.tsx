"use client";

import { useEffect, useRef } from "react";

/** A soft amber light that follows a fine pointer. Sets `--gx`/`--gy` on the parent so siblings can follow it too. */
export function Glow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        host.style.setProperty("--gx", `${e.clientX}px`);
        host.style.setProperty("--gy", `${e.clientY}px`);
        host.classList.add("is-lit");
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
    };
  }, []);

  return <div className="ambient-glow" ref={ref} />;
}
