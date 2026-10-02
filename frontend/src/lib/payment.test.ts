import { describe, expect, it } from 'vitest';
import { assertPaymentSupported, parseTokenAmount } from './payment';

describe('selected payment asset', () => {
  it('converts SOL and stablecoins using their own decimal precision', () => {
    expect(parseTokenAmount('0.45', 'SOL')).toBe(450_000_000);
    expect(parseTokenAmount('0.45', 'USDC')).toBe(450_000);
    expect(parseTokenAmount('1.000001', 'USDT')).toBe(1_000_001);
    expect(() => parseTokenAmount('1.0000001', 'USDC')).toThrow();
  });
  it('never submits a selected stablecoin or private transfer through SOL send', () => {
    expect(() => assertPaymentSupported('send', 'USDC')).toThrow('USDC');
    expect(() => assertPaymentSupported('withdraw', 'USDT')).toThrow('USDT');
    expect(() => assertPaymentSupported('transfer', 'SOL')).toThrow('private-to-private');
    expect(() => assertPaymentSupported('send', 'SOL')).not.toThrow();
    expect(() => assertPaymentSupported('withdraw', 'SOL')).not.toThrow();
  });
});
