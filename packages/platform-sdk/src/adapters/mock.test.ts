import { describe, expect, it } from 'vitest';
import { MockPlatformAdapter, createMockAdapter } from './mock';
import type { PublishProductDto } from '../types';

const sampleDto: PublishProductDto = {
  title: '纯棉短袖T恤',
  detailHtml: '<p>好货</p>',
  mainImages: ['https://img/1.jpg'],
  categoryId: 'mock-1-1',
  attributes: {},
  skus: [{ specName: '默认', price: 29, stock: 100, attributes: {} }],
  salePrice: 29,
};

describe('MockPlatformAdapter', () => {
  it('publishProduct returns a platform-scoped id and url', async () => {
    const adapter = createMockAdapter('douyin');
    const res = await adapter.publishProduct('tok', sampleDto);
    expect(res.platformProductId).toContain('douyin-');
    expect(res.url).toContain('mock.douyin.shop/item/');
  });

  it('buildAuthUrl embeds the state', () => {
    const adapter = new MockPlatformAdapter('taobao');
    expect(adapter.buildAuthUrl('abc123')).toContain('state=abc123');
  });

  it('exchangeToken returns a token set', async () => {
    const adapter = createMockAdapter('pdd');
    const token = await adapter.exchangeToken('code-1');
    expect(token.accessToken).toContain('mock-access-pdd-code-1');
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('getCategoryTree returns mock leaves', async () => {
    const tree = await createMockAdapter('douyin').getCategoryTree('tok');
    expect(tree.some((n) => n.isLeaf)).toBe(true);
  });

  it('returns optional mock category qualifications for the demo flow', async () => {
    await expect(
      createMockAdapter('douyin').getCategoryQualifications('tok', '20001'),
    ).resolves.toEqual([
      expect.objectContaining({ key: '9001', name: '质检报告', required: false }),
    ]);
  });

  it('persists inventory after publish, update and inventory sync', async () => {
    const adapter = createMockAdapter('douyin');
    const published = await adapter.publishProduct('tok', {
      ...sampleDto,
      skus: [
        {
          sourceSkuId: 'sku-z',
          specName: '黑色/L',
          price: 32,
          stock: 8,
          attributes: {},
        },
        {
          sourceSkuId: 'sku-a',
          specName: '白色/M',
          price: 29,
          stock: 12,
          attributes: {},
        },
      ],
    });

    await expect(adapter.getProductInventory('tok', published.platformProductId)).resolves.toEqual({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [
        { sourceSkuId: 'sku-a', stock: 12 },
        { sourceSkuId: 'sku-z', stock: 8 },
      ],
    });

    await adapter.updateProduct('tok', {
      ...sampleDto,
      platformProductId: published.platformProductId,
      skus: [
        {
          sourceSkuId: 'sku-z',
          specName: '黑色/L',
          price: 32,
          stock: 4,
          attributes: {},
        },
        {
          sourceSkuId: 'sku-a',
          specName: '白色/M',
          price: 29,
          stock: 9,
          attributes: {},
        },
      ],
    });
    await expect(adapter.getProductInventory('tok', published.platformProductId)).resolves.toEqual(
      expect.objectContaining({
        items: [
          { sourceSkuId: 'sku-a', stock: 9 },
          { sourceSkuId: 'sku-z', stock: 4 },
        ],
      }),
    );

    await adapter.syncInventory('tok', {
      platformProductId: published.platformProductId,
      idempotencyKey: 'inventory-1',
      items: [{ sourceSkuId: 'sku-z', stock: 0 }],
    });
    await expect(adapter.getProductInventory('tok', published.platformProductId)).resolves.toEqual(
      expect.objectContaining({
        items: [
          { sourceSkuId: 'sku-a', stock: 9 },
          { sourceSkuId: 'sku-z', stock: 0 },
        ],
      }),
    );

    await adapter.offlineProduct('tok', published.platformProductId);
    await expect(adapter.getProductState('tok', published.platformProductId)).resolves.toEqual({
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });
    await adapter.onlineProduct('tok', published.platformProductId);
    await expect(adapter.getProductState('tok', published.platformProductId)).resolves.toEqual({
      state: 'online',
      status: 0,
      checkStatus: 3,
    });
    await expect(adapter.getProductInventory('tok', published.platformProductId)).resolves.toEqual(
      expect.objectContaining({ state: 'online', status: 0 }),
    );
  });

  it('persists and reads a title-only update without changing product state', async () => {
    const adapter = createMockAdapter('douyin');
    const published = await adapter.publishProduct('tok', sampleDto);

    await expect(
      adapter.getProductTitle('tok', published.platformProductId),
    ).resolves.toMatchObject({ title: sampleDto.title, state: 'online' });
    await adapter.updateProductTitle('tok', {
      platformProductId: published.platformProductId,
      title: '更新后的纯棉短袖T恤',
    });
    await expect(
      adapter.getProductTitle('tok', published.platformProductId),
    ).resolves.toMatchObject({ title: '更新后的纯棉短袖T恤', state: 'online' });
  });

  it('fully replaces SKU rows while preserving retained IDs and keeping read models coherent', async () => {
    const adapter = createMockAdapter('douyin');
    const published = await adapter.publishProduct('tok', {
      ...sampleDto,
      skus: [
        {
          sourceSkuId: 'sku-z',
          specName: '黑色',
          price: 32,
          stock: 8,
          attributes: {},
        },
        {
          sourceSkuId: 'sku-a',
          specName: '白色',
          price: 29,
          stock: 12,
          attributes: {},
        },
      ],
    });
    const before = await adapter.getProductSkuState('tok', published.platformProductId);
    const retained = before.items.find((item) => item.platformSkuKey === 'sku-a')!;
    const removed = before.items.find((item) => item.platformSkuKey === 'sku-z')!;
    const dimension = retained.properties[0]!;

    await adapter.replaceProductSkus('tok', {
      platformProductId: published.platformProductId,
      keepOffline: true,
      dimensions: [
        {
          propertyId: dimension.propertyId,
          propertyName: dimension.propertyName,
          values: [
            {
              valueId: dimension.valueId,
              valueName: dimension.valueName,
            },
            { valueId: 'mock-value-green', valueName: '绿色' },
          ],
        },
      ],
      items: [
        {
          platformSkuId: retained.platformSkuId,
          platformSkuKey: retained.platformSkuKey,
          properties: retained.properties,
          priceCents: 3090,
          stock: 9,
          skuStatus: true,
          skuType: 0,
          code: null,
          supplierId: null,
          stepStock: 0,
          barcodes: [],
          skuPictureUrls: [],
        },
        {
          platformSkuKey: 'sku-new',
          properties: [
            {
              propertyId: dimension.propertyId,
              propertyName: dimension.propertyName,
              valueId: 'mock-value-green',
              valueName: '绿色',
              remark: null,
            },
          ],
          priceCents: 3390,
          stock: 4,
          skuStatus: true,
          skuType: 0,
          code: null,
          supplierId: null,
          stepStock: 0,
          barcodes: [],
          skuPictureUrls: ['https://img/new.jpg'],
        },
      ],
    });

    const after = await adapter.getProductSkuState('tok', published.platformProductId);
    expect(after).toMatchObject({ state: 'offline', startSaleType: 1 });
    expect(after.items.map((item) => item.platformSkuKey)).toEqual(['sku-a', 'sku-new']);
    expect(after.items[0]?.platformSkuId).toBe(retained.platformSkuId);
    expect(after.items[1]?.platformSkuId).toMatch(/^mock-sku-/);
    expect(after.items.map((item) => item.platformSkuId)).not.toContain(removed.platformSkuId);
    await expect(
      adapter.getProductPrices('tok', published.platformProductId),
    ).resolves.toMatchObject({
      items: [
        { sourceSkuId: 'sku-a', priceCents: 3090 },
        { sourceSkuId: 'sku-new', priceCents: 3390 },
      ],
    });
    await expect(
      adapter.getProductInventory('tok', published.platformProductId),
    ).resolves.toMatchObject({
      items: [
        { sourceSkuId: 'sku-a', stock: 9 },
        { sourceSkuId: 'sku-new', stock: 4 },
      ],
    });

    await adapter.updateProductPrice('tok', {
      platformProductId: published.platformProductId,
      sourceSkuId: 'sku-new',
      priceCents: 3490,
    });
    await adapter.syncInventory('tok', {
      platformProductId: published.platformProductId,
      idempotencyKey: 'sku-replacement-stock',
      items: [{ sourceSkuId: 'sku-new', stock: 2 }],
    });
    await expect(
      adapter.getProductSkuState('tok', published.platformProductId),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ platformSkuKey: 'sku-a' }),
        expect.objectContaining({ platformSkuKey: 'sku-new', priceCents: 3490, stock: 2 }),
      ],
    });
  });

  it('rejects an existing mock SKU paired with a different platform ID', async () => {
    const adapter = createMockAdapter('douyin');
    const published = await adapter.publishProduct('tok', {
      ...sampleDto,
      skus: [{ sourceSkuId: 'sku-a', specName: '白色', price: 29, stock: 12, attributes: {} }],
    });
    const state = await adapter.getProductSkuState('tok', published.platformProductId);
    const item = state.items[0]!;

    await expect(
      adapter.replaceProductSkus('tok', {
        platformProductId: published.platformProductId,
        keepOffline: true,
        dimensions: [
          {
            propertyId: item.properties[0]!.propertyId,
            propertyName: item.properties[0]!.propertyName,
            values: [
              {
                valueId: item.properties[0]!.valueId,
                valueName: item.properties[0]!.valueName,
              },
            ],
          },
        ],
        items: [{ ...item, platformSkuId: 'wrong-platform-id' }],
      }),
    ).rejects.toThrow('do not match');
  });

  it('rejects title updates for a mock product that was never published', async () => {
    const adapter = createMockAdapter('douyin');

    await expect(
      adapter.updateProductTitle('tok', {
        platformProductId: 'missing-product',
        title: '更新后的纯棉短袖T恤',
      }),
    ).rejects.toThrow('unavailable');
  });
});
