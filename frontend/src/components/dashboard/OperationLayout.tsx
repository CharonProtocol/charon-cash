import type { ReactNode } from "react";

export function OperationLayout({ children }: { children: ReactNode }) {
  return <div className="operation-layout">{children}</div>;
}
