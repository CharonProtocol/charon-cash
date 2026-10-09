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
    <div className="operation-layout">
      <header className="operation-header">
        <h1 className="operation-title">
          {title}{" "}
          <span className="operation-direction">
            {direction}
          </span>
        </h1>
      </header>
      <div className="operation-lantern" aria-hidden="true">
        <img src="/LanternOn.png" alt="" />
      </div>
      <div className="operation-content">
        {children}
      </div>
    </div>
  );
}
