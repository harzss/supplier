import { describe, expect, it } from 'vitest';
import {
  buildSourceBindingRoutes,
  findSourceBindingRoute,
  parseSourceBindingRoutes,
  sourceBindingFingerprint,
  sourceBindingRoutesFingerprint,
} from './source-binding';

const ROUTES = [
  {
    platformSkuKey: 'sku-blue-l',
    sourceSpecId: '1688-blue-l',
    sourceSpecRequired: true,
    sourceUnitCost: 12.5,
    values: ['蓝色', 'L'],
  },
  {
    platformSkuKey: 'sku-default',
    sourceSpecId: null,
    sourceSpecRequired: false,
    sourceUnitCost: 9.9,
    values: [],
  },
];

describe('published product source binding routes', () => {
  it('builds a one-to-one route map and prefers exact source SKU ids', () => {
    expect(
      buildSourceBindingRoutes(
        [
          { platformSkuKey: 'sku-black-l', values: ['平台改名的黑色', 'L'] },
          { platformSkuKey: 'platform-white-m', values: ['白色', 'M'] },
        ],
        [
          {
            skuId: 'sku-black-l',
            price: 12.5,
            attributes: { 颜色: '黑色', 尺码: 'L' },
          },
          {
            skuId: 'source-white-m',
            price: 10,
            attributes: { 颜色: '白色', 尺码: 'M' },
          },
        ],
        9.9,
      ),
    ).toEqual([
      {
        platformSkuKey: 'platform-white-m',
        sourceSpecId: 'source-white-m',
        sourceSpecRequired: true,
        sourceUnitCost: 10,
        values: ['白色', 'M'],
      },
      {
        platformSkuKey: 'sku-black-l',
        sourceSpecId: 'sku-black-l',
        sourceSpecRequired: true,
        sourceUnitCost: 12.5,
        values: ['平台改名的黑色', 'L'],
      },
    ]);
  });

  it('builds the only safe default route for a source without SKUs', () => {
    expect(
      buildSourceBindingRoutes([{ platformSkuKey: 'default', values: [] }], null, 9.9),
    ).toEqual([
      {
        platformSkuKey: 'default',
        sourceSpecId: null,
        sourceSpecRequired: false,
        sourceUnitCost: 9.9,
        values: [],
      },
    ]);
  });

  it('allows a uniquely matched published subset of a larger source SKU list', () => {
    expect(
      buildSourceBindingRoutes(
        [
          { platformSkuKey: 'sku-white', values: ['白色'] },
          { platformSkuKey: 'platform-black', values: ['黑色'] },
        ],
        [
          { skuId: 'sku-white', values: ['货源白色'], price: 10 },
          { skuId: 'sku-black', values: ['黑色'], price: 11 },
          { skuId: 'sku-disabled', values: ['灰色'], price: 9 },
        ],
        8,
      ),
    ).toEqual([
      {
        platformSkuKey: 'platform-black',
        sourceSpecId: 'sku-black',
        sourceSpecRequired: true,
        sourceUnitCost: 11,
        values: ['黑色'],
      },
      {
        platformSkuKey: 'sku-white',
        sourceSpecId: 'sku-white',
        sourceSpecRequired: true,
        sourceUnitCost: 10,
        values: ['白色'],
      },
    ]);
  });

  it.each([
    [
      'fewer source SKUs than platform routes',
      [
        { platformSkuKey: 'platform-1', values: ['白色'] },
        { platformSkuKey: 'platform-2', values: ['黑色'] },
      ],
      [{ skuId: 'source-1', values: ['白色'], price: 10 }],
    ],
    [
      'an ambiguous values-only match',
      [
        { platformSkuKey: 'platform-1', values: ['白色'] },
        { platformSkuKey: 'platform-2', values: ['白色'] },
      ],
      [
        { skuId: 'source-1', values: ['白色'], price: 10 },
        { skuId: 'source-2', values: ['白色'], price: 10 },
      ],
    ],
    [
      'a missing exact values match',
      [{ platformSkuKey: 'platform-1', values: ['黑色'] }],
      [{ skuId: 'source-1', values: ['白色'], price: 10 }],
    ],
    [
      'multiple default routes',
      [
        { platformSkuKey: 'default-1', values: [] },
        { platformSkuKey: 'default-2', values: [] },
      ],
      null,
    ],
  ])('rejects %s when building routes', (_label, platformRoutes, sourceSkus) => {
    expect(() => buildSourceBindingRoutes(platformRoutes, sourceSkus, 9.9)).toThrow();
  });

  it('strictly parses, normalizes and finds a route by its platform SKU key', () => {
    const parsed = parseSourceBindingRoutes([...ROUTES].reverse());

    expect(parsed.map((route) => route.platformSkuKey)).toEqual(['sku-blue-l', 'sku-default']);
    expect(findSourceBindingRoute(parsed, ' sku-blue-l ')).toEqual(ROUTES[0]);
    expect(findSourceBindingRoute(parsed, 'sku-missing')).toBeNull();
  });

  it.each([
    ['a non-array route set', {}],
    ['an unknown field', [{ ...ROUTES[0], extra: true }]],
    ['a duplicate platform key', [ROUTES[0], { ...ROUTES[0], sourceSpecId: 'another-spec' }]],
    ['a missing required source spec', [{ ...ROUTES[0], sourceSpecId: null }]],
    ['a non-positive cost', [{ ...ROUTES[0], sourceUnitCost: 0 }]],
    ['an invalid values member', [{ ...ROUTES[0], values: ['蓝色', 1] }]],
  ])('rejects %s', (_label, value) => {
    expect(() => parseSourceBindingRoutes(value)).toThrow();
  });

  it('produces order-independent route and full binding fingerprints', () => {
    const routeFingerprint = sourceBindingRoutesFingerprint(ROUTES);
    expect(sourceBindingRoutesFingerprint([...ROUTES].reverse())).toBe(routeFingerprint);
    expect(routeFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const input = {
      sourceProductId: 17n,
      sourceOfferId: '554456348334',
      sourceSupplierId: 'supplier-1',
      sourceOnePieceDrop: true,
      sourceFingerprint: 'source-fingerprint-1',
      inventoryFingerprint: 'inventory-fingerprint-1',
      inventoryVersion: 3,
      skuRoutes: ROUTES,
    };
    const bindingFingerprint = sourceBindingFingerprint(input);
    expect(sourceBindingFingerprint({ ...input, skuRoutes: [...ROUTES].reverse() })).toBe(
      bindingFingerprint,
    );
    expect(bindingFingerprint).not.toBe(routeFingerprint);
  });
});
