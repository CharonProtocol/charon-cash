import { useLayoutEffect, useRef, useState } from 'react';
import { TokenIcon, type Token } from './TokenIcon';

const TOKENS: Token[] = ['SOL', 'USDC', 'USDT'];

export function TokenSelector({ value, onChange }: { value: Token; onChange: (token: Token) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pill, setPill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const button = refs.current[TOKENS.indexOf(value)];
      if (!button) return;
      setPill({ left: button.offsetLeft, top: button.offsetTop, width: button.offsetWidth, height: button.offsetHeight });
    };
    measure();
    const frame = requestAnimationFrame(() => setAnimate(true));
    const observer = new ResizeObserver(measure);
    refs.current.forEach(button => button && observer.observe(button));
    if (listRef.current) observer.observe(listRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [value]);

  return (
    <div ref={listRef} className="relative isolate mx-auto flex w-fit gap-1 rounded-xl border border-[#d9d9d9] p-1.5 sm:gap-3 shrink-0 [@media(max-height:560px)]:gap-0.5" role="group" aria-label="Payment asset">
      {pill && <span aria-hidden="true" className={`pointer-events-none absolute rounded-lg bg-[#303030] shadow-sm ${animate ? 'transition-[left,top,width,height] duration-300 ease-out motion-reduce:transition-none' : ''}`} style={pill} />}
      {TOKENS.map((token, index) => (
        <button type="button" key={token} ref={button => { refs.current[index] = button; }} aria-pressed={value === token} onClick={() => onChange(token)} className={`relative z-10 flex items-center gap-2 rounded-lg px-3 py-2 text-xs! transition-colors duration-300 motion-reduce:transition-none sm:text-sm! focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 [@media(max-height:560px)]:py-1 ${value === token ? `${pill ? 'bg-transparent' : 'bg-[#303030]'} text-white` : 'bg-transparent text-neutral-800 hover:bg-neutral-100'}`}>
          <TokenIcon token={token} className="size-5 shrink-0 sm:size-6 [@media(max-height:560px)]:size-4" />
          {token === 'SOL' ? 'Sol' : token}
        </button>
      ))}
    </div>
  );
}
