import { BACKEND_URL } from "./config";

export type ProbeState = "up" | "down";
export type InfrastructureTone = "up" | "degraded" | "down";

export type InfrastructureSnapshot = {
  ready: boolean;
  tone: InfrastructureTone;
  backend: ProbeState;
  yellowstone: ProbeState;
  rpc: ProbeState;
};

export function aggregateInfrastructure(probes: {
  backend: ProbeState;
  yellowstone: ProbeState;
  rpc: ProbeState;
}): InfrastructureTone {
  if (probes.backend === "down") return "down";
  if (probes.yellowstone === "down" || probes.rpc === "down") return "degraded";
  return "up";
}

async function reachable(url: string, init?: RequestInit): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return false;
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === "object" && "success" in body) {
      return (body as { success: boolean }).success === true;
    }
    if (body && typeof body === "object" && "result" in body) {
      return (body as { result: unknown }).result === "ok";
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeInfrastructure(rpcUrl: string) {
  const base = BACKEND_URL;
  const [backend, yellowstone, rpc] = await Promise.all([
    reachable(`${base}/health`),
    reachable(`${base}/indexer/status`),
    reachable(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    }),
  ]);
  return {
    backend: (backend ? "up" : "down") as ProbeState,
    yellowstone: (yellowstone ? "up" : "down") as ProbeState,
    rpc: (rpc ? "up" : "down") as ProbeState,
  };
}
