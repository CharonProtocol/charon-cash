import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

const deployment = JSON.parse(readFileSync(new URL("../../../deployments/devnet.json", import.meta.url), "utf8"));
const profile = Object.fromEntries(
  readFileSync(new URL("../../.env.devnet", import.meta.url), "utf8")
    .split("\n").filter((line) => line.startsWith("VITE_"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries(profile)) vi.stubEnv(key, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("devnet integration", () => {
  it("keeps the frontend and built SDK on the recorded deployment", async () => {
    const config = await import("./config");
    const sdk = await import("../../../sdk/dist/constants");
    expect(config.IS_DEVNET).toBe(true);
    expect(config.RPC_URL).toBe(deployment.rpcUrl);
    expect(config.PROGRAM_ID).toBe(deployment.programId);
    expect(sdk.PROGRAM_ID.toBase58()).toBe(deployment.programId);
    expect(sdk.ALT_ADDRESS.toBase58()).toBe(deployment.altAddress);
    expect(sdk.FEE_RECIPIENT.toBase58()).toBe(deployment.feeRecipient);
    expect(sdk.API_URL).toBe(config.BACKEND_URL);
    expect(sdk.API_URL).toBe("");
    expect(sdk.SUPPORTED_SPL_MINTS).toEqual([deployment.testMint]);
    expect(sdk.STORAGE_NAMESPACE).toBe(`CHARONPROTOCOL_DB:devnet:${deployment.programId}`);
  });

  it("only offers SOL and the test token, with devnet explorer receipts", async () => {
    const config = await import("./config");
    const { TokenSelector } = await import("../components/dashboard/TokenSelector");
    expect(config.AVAILABLE_TOKENS).toEqual(["SOL", "TEST"]);
    expect(config.mintForToken("TEST")).toBe(deployment.testMint);
    expect(() => config.mintForToken("USDC")).toThrow("unavailable");
    expect(config.transactionExplorerUrl("receipt")).toBe("https://explorer.solana.com/tx/receipt?cluster=devnet");
    const html = renderToStaticMarkup(<TokenSelector value="TEST" onChange={() => {}} />);
    expect(html).toContain("Asset TEST. Choose SOL.");
    expect(html).not.toContain("USDC");
    expect(html).not.toContain("USDT");
    const { parseTokenAmount } = await import("./payment");
    expect(parseTokenAmount("1.000001", "TEST")).toBe(1_000_001);
  });

  it("rejects a leftover localnet backend before account initialization", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ program_id: "localnet" })));
    const { checkDevnetBackend } = await import("./devnet");
    await expect(checkDevnetBackend()).rejects.toThrow("does not match");
  });

  it("requires the devnet test mint in the backend's supported assets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      program_id: deployment.programId, fee_recipient: deployment.feeRecipient, supported_mints: [],
    })));
    const { checkDevnetBackend } = await import("./devnet");
    await expect(checkDevnetBackend()).rejects.toThrow("does not support");
  });

  it("accepts a matching backend through the configured API origin", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      program_id: deployment.programId, fee_recipient: deployment.feeRecipient,
      supported_mints: [{ mint: deployment.testMint }],
    }));
    vi.stubGlobal("fetch", fetch);
    const { checkDevnetBackend } = await import("./devnet");
    await expect(checkDevnetBackend()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/relayer/info", expect.any(Object));
  });

  it("explains an unreachable backend", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { checkDevnetBackend } = await import("./devnet");
    await expect(checkDevnetBackend()).rejects.toThrow("Start the local backend");
  });
});
