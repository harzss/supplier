import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { CategoryCatalogService, materializeCatalog } from './category-catalog.service';

const SHOP = {
  id: 9n,
  userId: 1n,
  platform: 'douyin',
  platformShopId: 'demo-douyin-1',
  shopName: '演示抖店',
  role: 'seller',
  status: 'active',
};

describe('CategoryCatalogService', () => {
  it('materializes stable category paths and rejects missing parents', () => {
    expect(
      materializeCatalog([
        { id: '20000', name: '女装', level: 1, isLeaf: false },
        { id: '20001', name: 'T恤', parentId: '20000', level: 2, isLeaf: true },
      ]),
    ).toEqual([
      expect.objectContaining({ id: '20000', path: '女装', enabled: true }),
      expect.objectContaining({ id: '20001', path: '女装/T恤', enabled: true }),
    ]);
    expect(() =>
      materializeCatalog([
        { id: '20001', name: 'T恤', parentId: 'missing', level: 2, isLeaf: true },
      ]),
    ).toThrow('缺少父节点');
  });

  it('replaces a shop catalog atomically after a complete adapter fetch', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = {
      shop: { findFirst: vi.fn().mockResolvedValue(SHOP) },
      shopCategory: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany,
        count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
        findFirst: vi.fn().mockResolvedValue({ syncedAt: new Date('2026-07-20T10:00:00.000Z') }),
      },
      $transaction: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaService;
    const adapters = {
      assertAllowed: vi.fn(),
      create: vi.fn().mockReturnValue({
        getCategoryTree: vi.fn().mockResolvedValue([
          { id: '20000', name: '女装', level: 1, isLeaf: false, enabled: true },
          {
            id: '20001',
            name: 'T恤',
            parentId: '20000',
            level: 2,
            isLeaf: true,
            enabled: true,
          },
        ]),
      }),
    } as unknown as PlatformAdapterFactory;
    const service = new CategoryCatalogService(prisma, adapters, {} as ShopTokenService);

    const result = await service.sync(1n, '9');

    expect(createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ categoryId: '20001', path: '女装/T恤', shopId: 9n }),
      ]),
    });
    expect(result).toMatchObject({ synced: true, nodeCount: 2, leafCount: 1 });
  });

  it('keeps only official predictions present in the synced enabled leaf catalog', async () => {
    const prisma = {
      shop: { findFirst: vi.fn().mockResolvedValue(SHOP) },
      sourceProduct: {
        findUnique: vi.fn().mockResolvedValue({
          productId1688: 'mock-1001',
          title: '纯棉短袖 T 恤',
        }),
      },
      shopCategory: {
        findFirst: vi.fn().mockResolvedValue({ syncedAt: new Date('2026-07-20T10:00:00.000Z') }),
        findMany: vi
          .fn()
          .mockResolvedValue([{ categoryId: '20001', name: 'T恤', path: '女装/T恤' }]),
      },
    } as unknown as PrismaService;
    const adapters = {
      assertAllowed: vi.fn(),
      create: vi.fn().mockReturnValue({
        recommendCategories: vi.fn().mockResolvedValue({
          recommendId: 'recommend-1',
          recommendations: [
            {
              categoryId: '20001',
              categoryName: 'T恤',
              categoryPath: '女装/T恤',
              qualificationStatus: 0,
            },
            {
              categoryId: '99999',
              categoryName: '过期类目',
              categoryPath: '过期类目',
              qualificationStatus: 0,
            },
          ],
        }),
      }),
    } as unknown as PlatformAdapterFactory;
    const service = new CategoryCatalogService(prisma, adapters, {} as ShopTokenService);

    const result = await service.suggestions(1n, 'mock-1001', '9');

    expect(result.candidates).toEqual([
      {
        rank: 1,
        categoryId: '20001',
        categoryName: 'T恤',
        categoryPath: '女装/T恤',
        qualificationStatus: 0,
        confidence: null,
      },
    ]);
  });
});
