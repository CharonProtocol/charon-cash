import { describe, expect, it } from 'vitest';
import { formatSol, parseSolAmount } from './amount';

describe('SOL amounts', () => {
  it('converts decimals without floating point rounding', () => {
    expect(parseSolAmount('1.000000001')).toBe(1_000_000_001);
    expect(parseSolAmount('0.000000001')).toBe(1);
    expect(parseSolAmount('0.29')).toBe(290_000_000);
  });
  it('rejects unsafe, negative, zero, and overly precise values', () => {
    for (const value of ['0', '-1', 'NaN', '1e9', '0.0000000001', '9007199.254740992', '', '1.2.3']) {
      expect(() => parseSolAmount(value)).toThrow();
    }
  });
  it('formats balances without losing lamports', () => {
    expect(formatSol('1000000001')).toBe('1.000000001');
    expect(formatSol('9007199254740993')).toBe('9007199.254740993');
    expect(formatSol('0')).toBe('0.00');
  });
});
