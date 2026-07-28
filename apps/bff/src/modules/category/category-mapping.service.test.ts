import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { CategoryCatalogService } from './category-catalog.service';
import { CategoryMappingService } from './category-mapping.service';

const PRODUCT = {
  id: 2n,
  productId1688: 'mock-1001',
  title: '纯棉短袖 T 恤',
  categoryPath: '女装/T恤',
};

describe('CategoryMappingService', () => {
  it('returns an unconfirmed view when the user has no mapping', async () => {
    const fixture = createFixture();

    const result = await fixture.service.get(1n, 'mock-1001', 'douyin');

    expect(result).toMatchObject({
      sourceProductId: 'mock-1001',
      platform: 'douyin',
      confirmed: false,
      categoryId: null,
    });
  });

  it('upserts a user-scoped confirmed Douyin leaf category', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.upsert.mockResolvedValue({
      categoryId: '123456',
      categoryName: '女式T恤',
      confirmedAt: new Date('2026-07-16T10:00:00.000Z'),
    });

    const result = await fixture.service.confirm(1n, 'mock-1001', {
      platform: 'douyin',
      categoryId: ' 123456 ',
      categoryName: ' 女式T恤 ',
    });

    expect(fixture.prisma.productCategoryMapping.upsert).toHaveBeenCalledWith({
      where: {
        uk_user_product_platform_category: {
          userId: 1n,
          sourceProductId: 2n,
          platform: 'douyin',
        },
      },
      create: expect.objectContaining({
        userId: 1n,
        sourceProductId: 2n,
        platform: 'douyin',
        categoryId: '123456',
        categoryName: '女式T恤',
      }),
      update: expect.objectContaining({
        categoryId: '123456',
        categoryName: '女式T恤',
      }),
    });
    expect(result.confirmed).toBe(true);
  });

  it('rejects non-numeric Douyin category IDs', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.confirm(1n, 'mock-1001', {
        platform: 'douyin',
        categoryId: 'women-tshirt',
      }),
    ).rejects.toThrow('必须是正整数');
    expect(fixture.prisma.productCategoryMapping.upsert).not.toHaveBeenCalled();
  });

  it('rejects category IDs outside the JavaScript safe-integer range', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.confirm(1n, 'mock-1001', {
        platform: 'douyin',
        categoryId: '9007199254740992',
      }),
    ).rejects.toThrow('必须是正整数');
  });

  it('validates a selected category against the synced shop catalog', async () => {
    const fixture = createFixture();
    fixture.prisma.productCategoryMapping.upsert.mockResolvedValue({
      categoryId: '123456',
      categoryName: '女式T恤',
      confirmedAt: new Date('2026-07-20T10:00:00.000Z'),
    });

    await fixture.service.confirm(1n, 'mock-1001', {
      platform: 'douyin',
      categoryId: '123456',
      categoryName: '女式T恤',
      shopId: '9',
    });

    expect(fixture.catalog.assertSelectable).toHaveBeenCalledWith(1n, '9', '123456');
  });
});

function createFixture() {
  const prisma = {
    sourceProduct: { findUnique: vi.fn().mockResolvedValue(PRODUCT) },
    productCategoryMapping: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const catalog = { assertSelectable: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new CategoryMappingService(
      prisma as unknown as PrismaService,
      catalog as unknown as CategoryCatalogService,
    ),
    prisma,
    catalog,
  };
}
