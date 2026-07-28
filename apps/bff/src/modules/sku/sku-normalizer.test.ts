import { describe, expect, it } from 'vitest';
import {
  buildSkuSuggestion,
  materializeConfirmedSkus,
  parseConfirmedSkuMapping,
} from './sku-normalizer';

const SOURCE_SKUS = [
  {
    skuId: 'sku-1',
    specName: '颜色:米白;尺寸:M',
    price: 10,
    stock: 12,
    attributes: { 颜色分类: '米白', 尺寸: 'M' },
  },
  {
    skuId: 'sku-2',
    specName: '颜色:黑色;尺寸:L',
    price: 12,
    stock: 0,
    attributes: { 颜色分类: '黑色', 尺寸: 'L' },
  },
];

describe('SKU normalizer', () => {
  it('normalizes dimension aliases and generates editable values', () => {
    const result = buildSkuSuggestion(SOURCE_SKUS, 9);

    expect(result.dimensions).toEqual(['颜色', '尺码']);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.skus).toEqual([
      expect.objectContaining({ sourceSkuId: 'sku-1', values: ['米白', 'M'], enabled: true }),
      expect.objectContaining({ sourceSkuId: 'sku-2', values: ['黑色', 'L'], enabled: false }),
    ]);
    expect(result.sourceFingerprint).toHaveLength(64);
  });

  it('parses key-value pairs from specName when attributes are absent', () => {
    const result = buildSkuSuggestion(
      [{ skuId: 'sku-1', specName: '颜色:白色;尺码:XL', price: 10, stock: 5 }],
      10,
    );
    expect(result.dimensions).toEqual(['颜色', '尺码']);
    expect(result.skus[0]?.values).toEqual(['白色', 'XL']);
  });

  it('falls back to one default SKU when the source has no SKU data', () => {
    const result = buildSkuSuggestion(null, 8.5);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.dimensions).toEqual([]);
    expect(result.skus[0]).toMatchObject({ sourceSkuId: 'default', costPrice: 8.5, stock: 999 });
  });

  it('materializes only enabled confirmed combinations', () => {
    const suggestion = buildSkuSuggestion(SOURCE_SKUS, 9);
    const mapping = parseConfirmedSkuMapping(
      ['颜色', '尺码'],
      [
        { sourceSkuId: 'sku-1', values: ['奶白', 'M'], enabled: true },
        { sourceSkuId: 'sku-2', values: ['黑色', 'L'], enabled: false },
      ],
      suggestion.sourceFingerprint,
    )!;

    expect(materializeConfirmedSkus(suggestion, mapping)).toEqual([
      expect.objectContaining({
        sourceSkuId: 'sku-1',
        values: ['奶白', 'M'],
        mappedAttributes: { 颜色: '奶白', 尺码: 'M' },
      }),
    ]);
  });
});
