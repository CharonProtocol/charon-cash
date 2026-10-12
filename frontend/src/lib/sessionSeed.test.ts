import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionSeed, sessionSignMessage, writeSessionSeed } from "./sessionSeed";

const pubkey = "11111111111111111111111111111111";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("session sign-in seed", () => {
  it("reuses a cached signature instead of asking the wallet again", async () => {
    const seed = Uint8Array.from([7, 8, 9]);
    writeSessionSeed(pubkey, seed);
    const signMessage = vi.fn(async () => Uint8Array.from([1]));
    const wrapped = sessionSignMessage(pubkey, signMessage);
    await expect(wrapped(new Uint8Array([0]))).resolves.toEqual(seed);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("stores the wallet signature after the first approval", async () => {
    const signature = Uint8Array.from([11, 12, 13, 14]);
    const signMessage = vi.fn(async () => signature);
    const wrapped = sessionSignMessage(pubkey, signMessage);
    await expect(wrapped(new Uint8Array([0]))).resolves.toEqual(signature);
    expect(readSessionSeed(pubkey)).toEqual(signature);
    await wrapped(new Uint8Array([1]));
    expect(signMessage).toHaveBeenCalledTimes(1);
  });
});
