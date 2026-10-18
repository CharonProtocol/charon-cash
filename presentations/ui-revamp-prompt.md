# Charon Pay — landing revamp prompt

Paste this into a fresh session (it is self-contained):

---

Revamp the landing page of **Charon Pay** (the `payroll/` app — React + Vite + Tailwind + shadcn/ui, lucide icons) with tasteful **micro-animations**. Do not touch the app shell, routes, or engine logic — this is the landing/hero experience only. No behavior changes.

**Brand.** Charon, the ferryman. The mark lives at `payroll/public/charon-mark.png` (a hooded ferryman with a lantern on dark water, transparent PNG). Voice: calm, precise, a little mysterious. Tagline: **"Move money. Leave no trace."** Accent: `#8B85F0` (dark theme), theme-aware via tokens only — never hardcode colors; the app is light-default with a dark toggle and both must look right.

**Feature these real numbers (do not invent others):**
- 100 salaries paid privately in ≈ 80 s — **one wallet signature** for the whole run
- **0 signatures** per payout after that
- ZK proofs built **in the browser**: 0.6–1.4 s per payout
- **134,244 CU** per payout · **1,066 B** transactions · **65 KB** on-chain program
- Parallel lanes 1–32, auto-scaled to the machine's cores
- Waitlist open — closed beta next

**Micro-animations to add (subtle, 60 fps, always respect `prefers-reduced-motion`):**
1. **Hero:** the ferryman mark fades/drifts in with a soft lantern-glow pulse; the tagline reveals word by word.
2. **Stats:** count-up when scrolled into view (IntersectionObserver), eased — `134,244` should roll like an odometer.
3. **Payment-path strip:** a small `You → proof → relay → recipient` SVG with a glowing packet looping end to end (stroke-dashoffset animation; the deck's flow slide is the reference).
4. **Hover:** cards lift ~2px with a gentle glow; the primary CTA breathes with a slow accent ring (`#8B85F0`, 3s loop).
5. **Background:** faint drifting water-caustics or star-field behind the hero, very low opacity — readability and perf come first.
6. **Scroll reveals:** sections rise 12 px and fade in, staggered ~60 ms.

**Constraints:** no new heavy dependencies — CSS transitions/keyframes plus at most a few IntersectionObservers; no framer-motion unless it's already a dependency. Zero layout shift, works at phone width, Lighthouse perf no worse than today. Deliver as edits to the landing components with all animation CSS in one dedicated file (e.g. `landing-motion.css`), each animation as a small composable utility class.
