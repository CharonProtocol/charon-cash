import { useLayoutEffect, useRef, useState } from "react";
import { TokenIcon, type Token } from "./TokenIcon";

const TOKENS: Token[] = ["SOL", "USDC", "USDT"];

export function TokenSelector({
  value,
  onChange,
  locked = false,
}: {
  value: Token;
  onChange: (token: Token) => void;
  locked?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pill, setPill] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const button = refs.current[TOKENS.indexOf(value)];
      if (!button) return;
      setPill({
        left: button.offsetLeft,
        top: button.offsetTop,
        width: button.offsetWidth,
        height: button.offsetHeight,
      });
    };
    measure();
    const frame = requestAnimationFrame(() => setAnimate(true));
    const observer = new ResizeObserver(measure);
    refs.current.forEach((button) => button && observer.observe(button));
    if (listRef.current) observer.observe(listRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [value]);

  return (
    <div
      ref={listRef}
      className="dashboard-token-selector"
      role="group"
      aria-label="Payment asset"
    >
      {pill && (
        <span
          aria-hidden="true"
          className={`dashboard-token-pill${animate ? " dashboard-token-pill--animate" : ""}`}
          style={pill}
        />
      )}
      {TOKENS.map((token, index) => (
        <button
          type="button"
          key={token}
          ref={(button) => {
            refs.current[index] = button;
          }}
          aria-pressed={value === token}
          disabled={locked}
          onClick={() => onChange(token)}
          className="dashboard-token-button"
        >
          <TokenIcon
            token={token}
            className="dashboard-token-icon"
          />
          {token}
        </button>
      ))}
    </div>
  );
}
