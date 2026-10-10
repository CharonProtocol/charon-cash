import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusLight } from "./StatusLight";

describe("infrastructure status light", () => {
  it("labels the aggregated tone and lists each probe", () => {
    const html = renderToStaticMarkup(
      <StatusLight
        placement="dock"
        status={{
          ready: true,
          tone: "degraded",
          backend: "up",
          yellowstone: "down",
          rpc: "up",
        }}
      />,
    );
    expect(html).toContain("Some systems degraded");
    expect(html).toContain("Backend");
    expect(html).toContain("Yellowstone");
    expect(html).toContain("RPC");
    expect(html).toContain("dashboard-status-light-dot--degraded");
  });
});
