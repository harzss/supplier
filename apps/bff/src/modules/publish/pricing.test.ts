import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { calculatePricing } from './pricing';

describe('calculatePricing', () => {
  it('keeps fixed markup behavior and exposes the real break-even price', () => {
    const quote = calculatePricing(10, { mode: 'fixed_markup', markupRatio: 0.5 });

    expect(quote.suggestedPrice).toBe(15);
    expect(quote.breakEvenPrice).toBe(14.74);
    expect(quote.estimatedProfit).toBe(0.25);
    expect(quote.warning).toBeNull();
  });

  it('reverses a sale price from target margin, shipping and platform fee', () => {
    const quote = calculatePricing(10, {
      mode: 'profit_target',
      targetMargin: 0.3,
      estimatedShipping: 4,
      platformFeeRate: 0.05,
    });

    expect(quote.suggestedPrice).toBe(21.54);
    expect(quote.breakEvenPrice).toBe(14.74);
    expect(quote.estimatedMargin).toBeCloseTo(0.3, 3);
  });

  it('anchors to the competitor midpoint but never goes below break-even', () => {
    const competitive = calculatePricing(10, {
      mode: 'competitor_anchor',
      competitorPriceRange: [20, 24],
      estimatedShipping: 4,
      platformFeeRate: 0.05,
    });
    expect(competitive.suggestedPrice).toBe(22);
    expect(competitive.warning).toBeNull();

    const uncompetitive = calculatePricing(20, {
      mode: 'competitor_anchor',
      competitorPriceRange: [18, 22],
      estimatedShipping: 4,
      platformFeeRate: 0.05,
    });
    expect(uncompetitive.suggestedPrice).toBe(uncompetitive.breakEvenPrice);
    expect(uncompetitive.warning).toContain('不具备价格竞争力');
  });

  it('rejects smart pricing when required inputs are invalid', () => {
    expect(() => calculatePricing(10, { mode: 'competitor_anchor' })).toThrow(BadRequestException);
    expect(() =>
      calculatePricing(10, {
        mode: 'profit_target',
        targetMargin: 0.8,
        platformFeeRate: 0.3,
      }),
    ).toThrow('目标毛利率与平台费率之和必须小于 100%');
  });

  it('reuses a persisted final price during queue retries', () => {
    const quote = calculatePricing(10, {
      mode: 'profit_target',
      targetMargin: 0.3,
      estimatedShipping: 4,
      platformFeeRate: 0.05,
      finalPrice: 19.99,
    } as never);

    expect(quote.suggestedPrice).toBe(19.99);
  });
});
