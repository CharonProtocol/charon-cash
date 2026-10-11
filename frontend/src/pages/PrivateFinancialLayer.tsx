import { createRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import "./PrivateFinancialLayer.css";

function SvgDefs() {
  return (
    <svg
      className="absolute w-0 h-0 overflow-hidden"
      aria-hidden="true"
    >
      <defs>
        <filter id="blur">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <symbol
          id="sol"
          viewBox="0 0 64 64"
        >
          <path
            fill="currentColor"
            d="M12 9h48L48 21H0ZM0 27h48l12 12H12ZM12 45h48L48 57H0Z"
          />
        </symbol>
        <symbol
          id="lamp"
          viewBox="0 0 512 704"
        >
          <g fill="currentColor">
            <path
              fillRule="evenodd"
              d="M256 4C220 4 194 22 189 52C182 83 193 108 227 121L237 104C214 96 205 78 209 56C213 34 231 23 256 23C281 23 299 34 303 56C307 78 298 96 275 104L285 121C319 108 330 83 323 52C318 22 292 4 256 4Z"
            />
            <path
              fillRule="evenodd"
              d="M256 76L271 90L286 121L333 157L323 177L438 273L430 292L411 303L416 316L403 321V542L426 568L305 623L300 632L256 681L212 632L207 623L86 568L109 542V321L96 316L101 303L82 292L74 273L189 177L179 157L226 121L241 90Z M139 320V536L237 525V300Z M275 300V525L373 536V320Z"
            />
          </g>
        </symbol>
        <symbol
          id="proof"
          viewBox="0 0 64 64"
        >
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M32 6L51 17V39L32 51L13 39V17Z" />
            <path d="M23 29L30 36L42 23" />
            <path
              d="M23 55L32 60L41 55"
              opacity=".45"
            />
          </g>
        </symbol>
      </defs>
    </svg>
  );
}

const NetworkGraphics = ({
  className,
  rotated,
}: {
  className?: string;
  rotated?: boolean;
}) => {
  return (
    <div
      className={`absolute pointer-events-none transition-opacity duration-400 network-perspective ${className}`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 900 600"
        className="w-full h-full overflow-visible"
      >
        <g transform={rotated ? "rotate(180 450 300)" : undefined}>
          <g className="fill-none stroke-[#969888] stroke-1 [vector-effect:non-scaling-stroke]">
            <path d="M40 140H250Q275 140 275 165V290Q275 315 300 315H470Q495 315 495 290V130Q495 105 520 105H790" />
            <path d="M470 315H710Q735 315 735 340V490" />
            <path d="M250 140V55H890" />
          </g>
          <g className="fill-none stroke-[#8b6c47] stroke-[2px] rounded-full [vector-effect:non-scaling-stroke] [stroke-dasharray:140_1060]">
            {/* Soft glows */}
            <path
              className="beam-soft animate-flow"
              pathLength="1200"
              d="M40 140H250Q275 140 275 165V290Q275 315 300 315H470Q495 315 495 290V130Q495 105 520 105H790"
            />

            {/* Core beams */}
            <path
              className="animate-flow"
              pathLength="1200"
              d="M40 140H250Q275 140 275 165V290Q275 315 300 315H470Q495 315 495 290V130Q495 105 520 105H790"
            />
            <path
              className="animate-flow [animation-delay:-4s] [animation-duration:11s]"
              pathLength="1200"
              d="M470 315H710Q735 315 735 340V490"
            />
            <path
              className="animate-flow [animation-delay:-7s] [animation-duration:13s]"
              pathLength="1200"
              d="M250 140V55H890"
            />
          </g>
          <g className="text-[#61695e] [filter:drop-shadow(0_12px_6px_#342e2118)]">
            <use
              href="#sol"
              x="34.5"
              y="120.5"
              width="36"
              height="36"
              transform={rotated ? "rotate(180 52.5 138.5)" : undefined}
            />
            <use
              href="#proof"
              x="234"
              y="114"
              width="46"
              height="46"
              transform={rotated ? "rotate(180 257.0 137.0)" : undefined}
            />
            <use
              href="#lamp"
              className="text-[#282e28] transition-colors duration-300"
              x="438"
              y="267"
              width="63"
              height="88"
              transform={rotated ? "rotate(180 469.5 311.0)" : undefined}
            />
            <use
              href="#proof"
              x="711"
              y="284"
              width="46"
              height="46"
              transform={rotated ? "rotate(180 734.0 307.0)" : undefined}
            />
            <use
              href="#sol"
              x="719.5"
              y="474.5"
              width="36"
              height="36"
              transform={rotated ? "rotate(180 737.5 492.5)" : undefined}
            />
          </g>
        </g>
      </svg>
    </div>
  );
};

// We will use standard React state to track hover instead of pure CSS to make it modular and allow motion animations.
export function PrivateFinancialLayer() {
  const [activeFeature, setActiveFeature] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const titleRefs = useMemo(
    () => Array.from({ length: 3 }, () => createRef<HTMLHeadingElement>()),
    [],
  );
  const buttonRefs = useMemo(
    () => Array.from({ length: 3 }, () => createRef<HTMLButtonElement>()),
    [],
  );
  const articleRefs = useMemo(
    () => Array.from({ length: 3 }, () => createRef<HTMLElement>()),
    [],
  );

  const [lanes, setLanes] = useState({ a: "", b: "" });

  useEffect(() => {
    if (!activeFeature) return;
    const fine = window.matchMedia("(hover: hover) and (min-width: 851px)").matches;
    if (fine) return;
    const close = () => setActiveFeature(null);
    window.addEventListener("scroll", close, { passive: true });
    return () => window.removeEventListener("scroll", close);
  }, [activeFeature]);

  useLayoutEffect(() => {
    const layoutLanes = () => {
      if (!sectionRef.current) return;
      const r = sectionRef.current.getBoundingClientRect();
      const mobile = window.innerWidth <= 850;

      const newLanes = { a: "", b: "" };

      for (let i = 0; i < 2; i++) {
        const aTitle = titleRefs[i].current;
        const bTitle = titleRefs[i + 1].current;
        const aButton = buttonRefs[i].current;
        const aArticle = articleRefs[i].current;
        const bArticle = articleRefs[i + 1].current;

        if (!aTitle || !bTitle || !aButton || !aArticle || !bArticle) continue;

        let d = "";
        if (mobile) {
          const from = aButton.getBoundingClientRect();
          const to = bArticle.getBoundingClientRect();
          const x1 = from.left - r.left + Math.min(38, from.width * 0.23);
          const y1 = from.bottom - r.top + 13;
          const x2 = to.left - r.left + Math.min(52, to.width * 0.26);
          const y2 = to.top - r.top - 16;
          const middle = (y1 + y2) / 2;
          const direction = x2 >= x1 ? 1 : -1;
          const radius = Math.max(
            2,
            Math.min(24, Math.abs(x2 - x1) / 3, Math.abs(y2 - y1) / 4),
          );
          d = `M${x1},${y1} L${x1},${middle - radius} Q${x1},${middle} ${x1 + direction * radius},${middle} L${x2 - direction * radius},${middle} Q${x2},${middle} ${x2},${middle + radius} L${x2},${y2}`;
        } else {
          const aLine = aTitle.querySelector<HTMLElement>(
            "[data-heading-line='last']",
          );
          const bLine = bTitle.querySelector<HTMLElement>(
            "[data-heading-line='first']",
          );
          if (!aLine || !bLine) continue;

          const aRect = aLine.getBoundingClientRect();
          const bRect = bLine.getBoundingClientRect();
          const x1 = aRect.right - r.left + 8;
          const y1 = aRect.top - r.top + aRect.height * 0.5;
          const x2 = bRect.left - r.left - 8;
          const y2 = bRect.top - r.top + bRect.height * 0.5;
          const bend = (x1 + x2) / 2;
          d = `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`;
        }
        if (i === 0) newLanes.a = d;
        if (i === 1) newLanes.b = d;
      }
      setLanes(newLanes);
    };

    const resizeObserver = new ResizeObserver(layoutLanes);
    if (sectionRef.current) resizeObserver.observe(sectionRef.current);
    for (const ref of [...titleRefs, ...buttonRefs, ...articleRefs]) {
      if (ref.current) resizeObserver.observe(ref.current);
    }
    for (const titleRef of titleRefs) {
      titleRef.current
        ?.querySelectorAll("[data-heading-line]")
        .forEach((line) => {
          resizeObserver.observe(line);
        });
    }
    window.addEventListener("resize", layoutLanes);
    document.fonts.ready.then(layoutLanes);
    layoutLanes();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", layoutLanes);
    };
  }, [titleRefs, buttonRefs, articleRefs]);

  return (
    <section
      ref={sectionRef}
      className="relative min-h-[600px] h-[100svh] overflow-hidden bg-[#FBF7EF] text-[#222622] isolate font-sans w-full"
      aria-label="Private financial capabilities"
      data-active={activeFeature}
    >
      <SvgDefs />

      {/* Background Grid */}
      <div
        className="absolute inset-0 z-[-2]"
        style={{
          backgroundImage:
            "linear-gradient(#333b2710 1px, transparent 1px), linear-gradient(90deg, #333b2710 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(ellipse at center, #000 0%, #0009 50%, transparent 85%)",
        }}
      />

      {/* Intro & Labels */}
      <div className="absolute top-[5%] left-[6.5%] md:left-[8%] flex items-center gap-[12px] text-[8px] md:text-[10px] tracking-[0.17em] uppercase text-[#77796e] max-h-[580px]:hidden">
        <span className="w-[6px] h-[6px] bg-[#987951] rounded-full inline-block" />
        Private Balance on a Public chain.
      </div>
      <div className="absolute bottom-[3%] left-[8%] md:left-[6.5%] text-[#77796e] text-[8px] md:text-[10px] tracking-[0.08em] max-h-[580px]:hidden">
        SOLANA × ZERO-KNOWLEDGE
      </div>
      <div className="absolute bottom-[3%] right-[6%] text-[10px] text-[#99998e] max-md:hidden max-h-[580px]:hidden">
        Hover or select a capability to explore
      </div>

      {/* Network Backgrounds */}
      <NetworkGraphics
        className={`w-[64%] h-[34%] left-[40%] top-[2%] md:w-[56%] md:h-[48%] md:left-[43%] md:top-[1%] ${activeFeature ? "opacity-82" : "opacity-45 md:opacity-66"}`}
      />
      <NetworkGraphics
        rotated
        className={`w-[69%] h-[40%] left-[-8%] top-[49%] md:w-[56%] md:h-[47%] md:left-[-1%] md:top-[51%] ${activeFeature ? "opacity-82" : "opacity-40 md:opacity-66"}`}
      />

      {/* SVG Accent Lanes */}
      <svg
        className="absolute pointer-events-none inset-0 w-full h-full z-0 opacity-80 md:opacity-100"
        aria-hidden="true"
      >
        <g className="heading-lanes">
          {/* We are simplifying the color animation part to just use the sweep for now to save complex JS ticking, the CSS sweep is the most visible part */}
          <path
            d={lanes.a}
            fill="none"
            stroke="#a49b8e"
            strokeWidth="1"
            className="opacity-30 md:opacity-38"
          />
          <path
            d={lanes.a}
            fill="none"
            className="stroke-[#96774f] opacity-70 stroke-[2px] max-md:hidden"
          />

          <path
            d={lanes.b}
            fill="none"
            stroke="#a49b8e"
            strokeWidth="1"
            className="opacity-30 md:opacity-38"
          />
          <path
            d={lanes.b}
            fill="none"
            className="stroke-[#96774f] opacity-70 stroke-[2px] max-md:hidden"
          />
        </g>
      </svg>

      {/* Feature 1: Transfer */}
      <FeatureCard
        id="transfer"
        isActive={activeFeature === "transfer"}
        onActivate={setActiveFeature}
        title="Shielded<br/>Transfers"
        eyebrow="Move privately"
        description="Send funds without exposing your financial activity."
        cta="Explore transfers"
        articleRef={articleRefs[0]}
        titleRef={titleRefs[0]}
        buttonRef={buttonRefs[0]}
        className="feature-anchor feature-anchor--transfer"
      >
        <PreviewCard
          title="Private transfer"
          status="Shielded"
          amount="4.80 SOL"
          receiptLeft="Recipient •••• 9mQa"
          receiptRight="Illustrative preview"
        />
      </FeatureCard>

      {/* Feature 2: Payroll */}
      <FeatureCard
        id="payroll"
        isActive={activeFeature === "payroll"}
        onActivate={setActiveFeature}
        title="Private<br/>Payroll"
        eyebrow="Pay your team"
        description="Pay your team while keeping individual payments private."
        cta="Explore payroll"
        articleRef={articleRefs[1]}
        titleRef={titleRefs[1]}
        buttonRef={buttonRefs[1]}
        className="feature-anchor feature-anchor--payroll"
      >
        <PreviewCard
          title="Team payroll"
          status="Private batch"
          customBody={
            <>
              <div className="flex items-center gap-[10px] my-[12px] text-[11px]">
                <span className="h-[24px] w-[24px] border border-[#dfdacc] rounded-full grid place-items-center text-[9px]">
                  AM
                </span>
                Team member
                <span className="ml-auto tracking-[3px] text-[#8e9183]">
                  ••••
                </span>
              </div>
              <div className="flex items-center gap-[10px] my-[12px] text-[11px]">
                <span className="h-[24px] w-[24px] border border-[#dfdacc] rounded-full grid place-items-center text-[9px]">
                  RK
                </span>
                Team member
                <span className="ml-auto tracking-[3px] text-[#8e9183]">
                  ••••
                </span>
              </div>
            </>
          }
          receiptLeft="Amounts concealed"
          receiptRight="Illustrative preview"
        />
      </FeatureCard>

      {/* Feature 3: Swap */}
      <FeatureCard
        id="swap"
        isActive={activeFeature === "swap"}
        onActivate={setActiveFeature}
        title="Shielded<br/>Swap"
        eyebrow="Exchange privately"
        description="Exchange assets through your private financial layer."
        cta="Explore swaps"
        articleRef={articleRefs[2]}
        titleRef={titleRefs[2]}
        buttonRef={buttonRefs[2]}
        className="feature-anchor feature-anchor--swap"
      >
        <PreviewCard
          title="Shielded exchange"
          status="Private"
          customBody={
            <div className="flex items-center justify-between py-[12px] text-[14px]">
              <span>SOL</span>
              <span className="text-[#929587] text-[11px]">⇄</span>
              <span>USDC</span>
            </div>
          }
          receiptLeft="Protected activity"
          receiptRight="Illustrative preview"
        />
      </FeatureCard>
    </section>
  );
}

// ----------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------

interface FeatureCardProps {
  id: string;
  isActive: boolean;
  onActivate: (id: string | null) => void;
  title: string;
  eyebrow: string;
  description: string;
  cta: string;
  className?: string;
  articleRef: React.RefObject<HTMLElement | null>;
  titleRef: React.RefObject<HTMLHeadingElement | null>;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}

function FeatureCard({
  id,
  isActive,
  onActivate,
  title,
  eyebrow,
  description,
  cta,
  className,
  articleRef,
  titleRef,
  buttonRef,
  children,
}: FeatureCardProps) {
  const [firstLine, lastLine] = title.split("<br/>");
  const coarse =
    typeof window !== "undefined" &&
    window.matchMedia("(hover: none), (max-width: 850px)").matches;

  return (
    <article
      ref={articleRef}
      className={`absolute transition-all duration-300 ${isActive ? "z-10" : "z-3"} ${className}`}
      onMouseEnter={() => {
        if (!coarse) onActivate(id);
      }}
      onMouseLeave={() => {
        if (!coarse) onActivate(null);
      }}
    >
      <button
        ref={buttonRef}
        aria-expanded={isActive}
        aria-controls={`${id}-preview`}
        onFocus={() => {
          if (!coarse) onActivate(id);
        }}
        onBlur={() => {
          if (!coarse) onActivate(null);
        }}
        onClick={() => onActivate(isActive ? null : id)}
        className="border-0 bg-transparent text-left p-0 cursor-pointer outline-offset-[10px] focus-visible:outline-2 focus-visible:outline-[#947551] focus-visible:rounded-[3px] group block w-full"
      >
        <span className="block text-[8px] md:text-[9px] tracking-[0.16em] uppercase text-[#8a8174] mb-[8px] md:mb-[12px] max-h-[580px]:hidden">
          {eyebrow}
        </span>
        <h2
          ref={titleRef}
          className="text-[clamp(24px,5.5vw,38px)] md:text-[clamp(25px,3.25vw,52px)] max-h-[580px]:text-[24px] font-medium leading-[1.08] tracking-[-0.045em] m-0 mb-[12px]"
        >
          <span data-heading-line="first">{firstLine}</span>
          <br />
          <span data-heading-line="last">{lastLine}</span>
        </h2>
        <p className="text-[11px] md:text-[clamp(11px,1vw,14px)] max-h-[580px]:text-[10px] leading-[1.45] md:leading-[1.5] text-[#77796e] max-w-[230px] md:max-w-[250px] m-0">
          {description}
        </p>
        <span className="inline-flex gap-[13px] items-center mt-[10px] md:mt-[12px] max-h-[580px]:mt-[6px] text-[10px] md:text-[11px] font-medium">
          {cta}
          <span
            aria-hidden="true"
            className="transition-transform duration-300 group-hover:translate-x-[5px]"
          >
            ↗
          </span>
        </span>
      </button>

      <AnimatePresence>
        {isActive && (
          <motion.div
            id={`${id}-preview`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className={`feature-preview${id === "swap" ? " feature-preview--up" : ""}`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

interface PreviewCardProps {
  title: string;
  status: string;
  amount?: string;
  customBody?: React.ReactNode;
  receiptLeft: string;
  receiptRight: string;
}

function PreviewCard({
  title,
  status,
  amount,
  customBody,
  receiptLeft,
  receiptRight,
}: PreviewCardProps) {
  return (
    <div className="preview-card">
      <div className="flex justify-between items-center mb-[18px] max-h-[580px]:mb-[10px] text-[11px] text-[#6e7267]">
        {title}
        <span className="text-[9px] tracking-[0.02em] bg-[#e7ecdf] text-[#637057] px-[8px] py-[5px] rounded-[20px]">
          {status}
        </span>
      </div>

      {amount && (
        <div className="text-[24px] font-medium tracking-[-0.04em]">
          {amount}
        </div>
      )}

      {customBody}

      <div className="mt-[15px] border-t border-[#e8e3da] pt-[12px] flex justify-between text-[10px] text-[#838377]">
        <span>{receiptLeft}</span>
        <span>{receiptRight}</span>
      </div>
    </div>
  );
}
