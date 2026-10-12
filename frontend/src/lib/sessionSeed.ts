const PREFIX = "charon:signin:";

function storage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

export function readSessionSeed(pubkey: string): Uint8Array | null {
  try {
    const raw = storage()?.getItem(PREFIX + pubkey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (
      !parsed.every(
        (value) =>
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= 0 &&
          value <= 255,
      )
    ) {
      return null;
    }
    return Uint8Array.from(parsed);
  } catch {
    return null;
  }
}

export function writeSessionSeed(pubkey: string, seed: Uint8Array) {
  try {
    storage()?.setItem(PREFIX + pubkey, JSON.stringify(Array.from(seed)));
  } catch {
    // private mode / quota — next load will sign again
  }
}

export function sessionSignMessage(
  pubkey: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): (message: Uint8Array) => Promise<Uint8Array> {
  return async (message) => {
    const cached = readSessionSeed(pubkey);
    if (cached) return cached;
    const signature = await signMessage(message);
    writeSessionSeed(pubkey, signature);
    return signature;
  };
}
