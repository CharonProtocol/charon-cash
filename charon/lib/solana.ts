const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ZERO = BigInt(0);
const BASE = BigInt(58);

/** True when `value` is base58 that decodes to exactly 32 bytes, the shape of a Solana public key. */
export function isSolanaAddress(value: string) {
  if (value.length < 32 || value.length > 44) return false;
  let n = ZERO;
  for (const ch of value) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return false;
    n = n * BASE + BigInt(digit);
  }
  let zeros = 0;
  while (value[zeros] === "1") zeros++;
  const body = n === ZERO ? 0 : Math.ceil(n.toString(16).length / 2);
  return zeros + body === 32;
}
