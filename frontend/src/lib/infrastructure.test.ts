import { describe, expect, it } from "vitest";
import { aggregateInfrastructure } from "./infrastructure";

describe("infrastructure status light", () => {
  it("goes red when the backend is unreachable", () => {
    expect(
      aggregateInfrastructure({
        backend: "down",
        yellowstone: "up",
        rpc: "up",
      }),
    ).toBe("down");
  });

  it("goes amber when the backend is up but indexer or RPC is down", () => {
    expect(
      aggregateInfrastructure({
        backend: "up",
        yellowstone: "down",
        rpc: "up",
      }),
    ).toBe("degraded");
    expect(
      aggregateInfrastructure({
        backend: "up",
        yellowstone: "up",
        rpc: "down",
      }),
    ).toBe("degraded");
  });

  it("goes green only when every probe succeeds", () => {
    expect(
      aggregateInfrastructure({
        backend: "up",
        yellowstone: "up",
        rpc: "up",
      }),
    ).toBe("up");
  });
});
