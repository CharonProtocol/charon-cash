import type { ReactNode } from "react";

export function OperationLayout({
  title,
  direction,
  children,
}: {
  title: string;
  direction: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-start">
      <header className="">
        <h1 className="relative text-3xl font-normal text-black">
          {title}{" "}
          <p className="absolute top-full left-3/4 text-xs whitespace-nowrap text-black">
            {direction}
          </p>
        </h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col justify-between py-8 [@media(max-height:560px)]:py-4">
        {children}
      </div>
    </div>
  );
}
