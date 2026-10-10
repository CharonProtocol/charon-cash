import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LazyMotion, domMax, MotionConfig } from 'motion/react';
import { TokenSelector } from './TokenSelector';
import { Withdraw } from './operations/Withdraw';
import { Send } from './operations/Send';
import { ShieldedTransfer } from './operations/ShieldedTransfer';
import type { PaymentContext } from './types';
const context: PaymentContext = { client: null, connected: true, address: '11111111111111111111111111111111', limit: '0', refresh: () => {}, observeProgress: () => {}, onBusyChange: () => {} };

describe('independent payment operations and asset selection', () => {
  it.each([
    { Component: Send },
    { Component: ShieldedTransfer },
  ])('renders $Component.name with its own amount step', ({ Component }) => {
    const html = renderToStaticMarkup(<MotionConfig reducedMotion="always"><LazyMotion features={domMax}><Component context={context}/></LazyMotion></MotionConfig>);
    expect(html).toContain('Step 1 of 3');
    expect(html).toContain('Continue to recipient');
    expect(html).toContain('id="pay-amount"');
    expect(html).not.toContain('To your connected wallet');
  });
  it('makes every asset selectable and uses the supplied SVG artwork', () => {
    const html = renderToStaticMarkup(<TokenSelector value="USDC" onChange={() => {}}/>);
    expect(html).not.toContain('disabled');
    expect(html.match(/<svg/g)).toHaveLength(3);
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Usdc--Streamline-Cryptocurrency/);
    expect(html).toContain('fill="#3e73c4"');
    expect(html).toContain('stop-color="#9945FF"');
  });
  it('withdraw has exactly two steps and no recipient input', () => {
    const html = renderToStaticMarkup(<MotionConfig reducedMotion="always"><LazyMotion features={domMax}><Withdraw context={context}/></LazyMotion></MotionConfig>);
    expect(html).toContain('Step 1 of 2');
    expect(html).toContain('Withdraw to connected wallet');
    expect(html).not.toContain('id="pay-recipient"');
  });
});
