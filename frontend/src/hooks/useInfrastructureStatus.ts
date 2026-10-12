import { useEffect, useState } from "react";
import { RPC_URL } from "../lib/config";
import {
  aggregateInfrastructure,
  probeInfrastructure,
  type InfrastructureSnapshot,
} from "../lib/infrastructure";

const POLL_MS = 5000;

const idle: InfrastructureSnapshot = {
  ready: false,
  tone: "down",
  backend: "down",
  yellowstone: "down",
  rpc: "down",
};

export function useInfrastructureStatus() {
  const [status, setStatus] = useState<InfrastructureSnapshot>(idle);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const probes = await probeInfrastructure(RPC_URL);
      if (cancelled) return;
      setStatus({
        ready: true,
        tone: aggregateInfrastructure(probes),
        ...probes,
      });
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return status;
}
