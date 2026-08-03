import { describe, expect, it } from 'vitest';
import { pricingSourceFingerprint } from './pricing-source-fingerprint';

const SOURCE = {
  price: 10,
  skuList: [
    { skuId: 'a', specName: '白色/M', price: 10, stock: 5 },
    { skuId: 'b', specName: '黑色/L', price: 12, stock: 6 },
  ],
};

describe('pricingSourceFingerprint', () => {
  it('changes when a non-minimum SKU cost changes', () => {
    const changed = {
      ...SOURCE,
      skuList: [SOURCE.skuList[0], { ...SOURCE.skuList[1], price: 13 }],
    };

    expect(pricingSourceFingerprint(changed)).not.toBe(pricingSourceFingerprint(SOURCE));
  });

  it('does not change for stock-only updates', () => {
    const changed = {
      ...SOURCE,
      skuList: SOURCE.skuList.map((sku) => ({ ...sku, stock: sku.stock + 10 })),
    };

    expect(pricingSourceFingerprint(changed)).toBe(pricingSourceFingerprint(SOURCE));
  });
});
