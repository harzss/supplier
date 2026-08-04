import { describe, expect, it } from 'vitest';
import { inventorySnapshot, offlineInventorySnapshot } from './inventory';

describe('source inventory snapshot', () => {
  it('sums normalized SKU stock and is independent of SKU order', () => {
    const first = inventorySnapshot({
      productId1688: '1001',
      skuList: [
        { skuId: 'b', specName: 'B', price: 2, stock: 3 },
        { skuId: 'a', specName: 'A', price: 1, stock: 7 },
      ],
    });
    const second = inventorySnapshot({
      productId1688: '1001',
      skuList: [
        { skuId: 'a', specName: 'A', price: 1, stock: 7 },
        { skuId: 'b', specName: 'B', price: 2, stock: 3 },
      ],
    });

    expect(first).toMatchObject({ availability: 'available', totalStock: 10 });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('marks a product with explicit zero SKU stock as out of stock', () => {
    expect(
      inventorySnapshot({
        productId1688: '1002',
        skuList: [{ skuId: 'sku-1', specName: '默认', price: 1, stock: 0 }],
      }),
    ).toMatchObject({ availability: 'out_of_stock', totalStock: 0 });
  });

  it('keeps products without SKU inventory in an unknown state', () => {
    expect(inventorySnapshot({ productId1688: '1003', skuList: [] })).toMatchObject({
      availability: 'unknown',
      totalStock: 0,
    });
  });

  it('creates a deterministic offline snapshot', () => {
    expect(offlineInventorySnapshot('1004')).toEqual(offlineInventorySnapshot('1004'));
    expect(offlineInventorySnapshot('1004')).toMatchObject({
      availability: 'offline',
      totalStock: 0,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2_147_483_648])(
    'rejects malformed or PostgreSQL-incompatible SKU stock %s',
    (stock) => {
      expect(() =>
        inventorySnapshot({
          productId1688: '1005',
          skuList: [{ skuId: 'sku-1', specName: '默认', price: 1, stock }],
        }),
      ).toThrow(/stock/i);
    },
  );

  it('rejects a total stock value that cannot be stored in a PostgreSQL integer', () => {
    expect(() =>
      inventorySnapshot({
        productId1688: '1006',
        skuList: [
          { skuId: 'sku-1', specName: 'A', price: 1, stock: 2_147_483_647 },
          { skuId: 'sku-2', specName: 'B', price: 1, stock: 1 },
        ],
      }),
    ).toThrow(/total stock/i);
  });

  it('accepts the PostgreSQL integer stock boundary', () => {
    expect(
      inventorySnapshot({
        productId1688: '1007',
        skuList: [{ skuId: 'sku-1', specName: '默认', price: 1, stock: 2_147_483_647 }],
      }),
    ).toMatchObject({ availability: 'available', totalStock: 2_147_483_647 });
  });

  it('rejects empty and duplicate normalized SKU IDs', () => {
    expect(() =>
      inventorySnapshot({
        productId1688: '1008',
        skuList: [{ skuId: ' ', specName: '默认', price: 1, stock: 1 }],
      }),
    ).toThrow(/SKU ID/i);
    expect(() =>
      inventorySnapshot({
        productId1688: '1008',
        skuList: [
          { skuId: 'sku-1', specName: 'A', price: 1, stock: 1 },
          { skuId: ' sku-1 ', specName: 'B', price: 1, stock: 1 },
        ],
      }),
    ).toThrow(/duplicate/i);
  });
});
