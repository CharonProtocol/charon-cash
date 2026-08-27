import React, { createContext, useContext } from "react";
import type { SdkBridgeHandle } from "./SdkWebView";
import type { BridgeMethod } from "../lib/rpc";

interface BridgeCtx {
  call: SdkBridgeHandle["call"];
}

const Ctx = createContext<BridgeCtx | null>(null);

export function BridgeProvider({
  call,
  children,
}: {
  call: SdkBridgeHandle["call"];
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={{ call }}>{children}</Ctx.Provider>;
}

export function useBridge(): BridgeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBridge must be used within BridgeProvider");
  return ctx;
}

export type { BridgeMethod };
