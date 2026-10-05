import type { ReactNode } from "react";

export function OperationLayout({ title, direction, children }: { title: string; direction: string; children: ReactNode }) {
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-[clamp(8px,2dvh,18px)]">
      <div className="min-w-0">
        <h1 className="m-0 text-[clamp(24px,4dvh,36px)] leading-tight font-normal tracking-[-2px]">{title}</h1>
        <p className="mt-1 ml-6 text-[11px]">{direction}</p>
      </div>
      {children}
    </div>
  );
}
