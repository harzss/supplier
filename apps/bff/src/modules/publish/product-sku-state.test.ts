import type { PlatformProductSkuRules, PlatformProductSkuState } from '@supplier/platform-sdk';
import { describe, expect, it } from 'vitest';
import {
  normalizeProductSkuRules,
  normalizeProductSkuState,
  productSkuCurrentDimensions,
} from './product-sku-state';

const STATE: PlatformProductSkuState = {
  state: 'offline',
  status: 1,
  checkStatus: 3,
  categoryId: 'cat-1',
  productType: 0,
  startSaleType: 0,
  items: [
    {
      platformSkuId: '1001',
      platformSkuKey: 'sku-a',
      properties: [],
      priceCents: 2990,
      stock: 7,
      skuStatus: true,
      skuType: 0,
      code: null,
      supplierId: null,
      stepStock: 0,
      barcodes: [],
      skuPictureUrls: [],
    },
  ],
};

const RULES: PlatformProductSkuRules = {
  maxDimensions: 1,
  maxCombinations: 100,
  maxValuesPerDimension: 100,
  supportsDimensionReordering: false,
  supportsCustomDimensions: false,
  allSkuPicturesRequired: false,
  dimensions: [
    {
      propertyId: 'color',
      propertyName: '颜色',
      required: true,
      supportsCustomValues: false,
      supportsRemark: false,
      requiresPagedValues: false,
      navigationProperties: [],
      values: [{ valueId: 'white', valueName: '白色' }],
      unsupportedReasons: [],
    },
  ],
  unsupportedReasons: [],
};

describe('product SKU state contract', () => {
  it('rejects an unknown platform state instead of persisting it as trusted readback', () => {
    expect(() =>
      normalizeProductSkuState({
        ...STATE,
        state: 'mystery',
      } as unknown as PlatformProductSkuState),
    ).toThrow('平台商品状态无效');
  });

  it('rejects a missing SKU status instead of silently coercing it to false', () => {
    const item = { ...STATE.items[0] } as Record<string, unknown>;
    delete item.skuStatus;

    expect(() =>
      normalizeProductSkuState({
        ...STATE,
        items: [item],
      } as unknown as PlatformProductSkuState),
    ).toThrow('平台 SKU 状态无效');
  });

  it('rejects incomplete rule booleans instead of weakening platform constraints', () => {
    const value = { ...RULES } as Record<string, unknown>;
    delete value.allSkuPicturesRequired;

    expect(() => normalizeProductSkuRules(value as unknown as PlatformProductSkuRules)).toThrow(
      '平台 SKU 规则无效',
    );
  });

  it('keeps custom values with the same platform ID distinct by name and remark', () => {
    expect(
      productSkuCurrentDimensions({
        ...STATE,
        items: [
          {
            ...STATE.items[0]!,
            properties: [
              {
                propertyId: 'color',
                propertyName: '颜色',
                valueId: '0',
                valueName: '自定义',
                remark: '雾蓝',
              },
            ],
          },
          {
            ...STATE.items[0]!,
            platformSkuId: '1002',
            platformSkuKey: 'sku-b',
            properties: [
              {
                propertyId: 'color',
                propertyName: '颜色',
                valueId: '0',
                valueName: '自定义',
                remark: '月白',
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        propertyId: 'color',
        propertyName: '颜色',
        values: [
          { valueId: '0', valueName: '自定义', remark: '雾蓝' },
          { valueId: '0', valueName: '自定义', remark: '月白' },
        ],
      },
    ]);
  });

  it('rejects cross-row property order drift', () => {
    const properties = [
      {
        propertyId: 'color',
        propertyName: '颜色',
        valueId: 'white',
        valueName: '白色',
        remark: null,
      },
      {
        propertyId: 'size',
        propertyName: '尺码',
        valueId: 'm',
        valueName: 'M',
        remark: null,
      },
    ];

    expect(() =>
      productSkuCurrentDimensions({
        ...STATE,
        items: [
          { ...STATE.items[0]!, properties },
          {
            ...STATE.items[0]!,
            platformSkuId: '1002',
            platformSkuKey: 'sku-b',
            properties: [...properties].reverse(),
          },
        ],
      }),
    ).toThrow('平台 SKU 规格结构不一致');
  });

  it('accepts two custom dimensions with property ID zero', () => {
    expect(
      normalizeProductSkuRules({
        ...RULES,
        maxDimensions: 2,
        supportsCustomDimensions: true,
        dimensions: [
          { ...RULES.dimensions[0]!, propertyId: '0', propertyName: '色号' },
          { ...RULES.dimensions[0]!, propertyId: '0', propertyName: '纹理', required: false },
        ],
      }).dimensions,
    ).toHaveLength(2);
  });

  it('rejects conflicting names for the same official nonzero property ID', () => {
    expect(() =>
      normalizeProductSkuRules({
        ...RULES,
        maxDimensions: 2,
        dimensions: [
          { ...RULES.dimensions[0]!, propertyId: '10', propertyName: '颜色' },
          { ...RULES.dimensions[0]!, propertyId: '10', propertyName: '色号' },
        ],
      }),
    ).toThrow('平台 SKU 规则包含重复属性');
  });
});
