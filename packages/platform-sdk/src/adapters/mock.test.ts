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
