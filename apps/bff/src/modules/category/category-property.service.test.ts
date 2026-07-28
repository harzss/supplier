import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { CategoryPropertyService } from './category-property.service';

const SHOP = {
  id: 9n,
  userId: 1n,
  platform: 'douyin',
  platformShopId: 'demo-douyin-1',
  shopName: '演示抖店',
  role: 'seller',
  status: 'active',
};
const PRODUCT = { id: 2n, productId1688: 'mock-1001', title: '纯棉短袖 T 恤' };
const CATEGORY = {
  categoryId: '20001',
  categoryName: 'T恤',
};
const ATTRIBUTES = [
  {
    id: '2176',
    name: '材质',
    required: true,
    multiValue: false,
    inputType: 'select' as const,
    supportsCustom: true,
    values: [
      { id: '111', name: '棉' },
      { id: '112', name: '聚酯纤维' },
    ],
  },
];

describe('CategoryPropertyService', () => {
  it('loads and caches official category attributes on demand', async () => {
    const fixture = createFixture({ attributes: null, attributesFingerprint: null });

    const result = await fixture.service.get(1n, 'mock-1001', '9');

    expect(fixture.getCategoryAttributes).toHaveBeenCalledWith('mock-token', '20001');
    expect(fixture.prisma.shopCategory.update).toHaveBeenCalledWith({
      where: { id: 30n },
      data: expect.objectContaining({
        attributes: ATTRIBUTES,
        attributesFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(result).toMatchObject({ confirmed: false, attributes: ATTRIBUTES, blockers: [] });
  });

  it('validates and stores official or custom values for every required property', async () => {
    const fixture = createFixture({
      attributes: ATTRIBUTES,
      attributesFingerprint: 'a'.repeat(64),
    });
    fixture.prisma.productCategoryPropertyMapping.findUnique.mockResolvedValue({
      categoryId: '20001',
      schemaFingerprint: 'a'.repeat(64),
      values: { '2176': [{ value: 111, name: '棉', diyType: 0 }] },
      confirmedAt: new Date('2026-07-20T10:00:00.000Z'),
    });

    const result = await fixture.service.confirm(1n, 'mock-1001', {
      shopId: '9',
      values: [{ propertyId: '2176', selections: [{ valueId: '111', name: '棉' }] }],
    });

    expect(fixture.prisma.productCategoryPropertyMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          categoryId: '20001',
          schemaFingerprint: 'a'.repeat(64),
          values: { '2176': [{ value: 111, name: '棉', diyType: 0 }] },
        }),
      }),
    );
    expect(result.confirmed).toBe(true);
  });

  it('refreshes official attributes even when a cached schema exists', async () => {
    const fixture = createFixture({
      attributes: ATTRIBUTES,
      attributesFingerprint: 'a'.repeat(64),
    });

    await fixture.service.sync(1n, 'mock-1001', '9');

    expect(fixture.getCategoryAttributes).toHaveBeenCalledWith('mock-token', '20001');
    expect(fixture.prisma.shopCategory.update).toHaveBeenCalledWith({
      where: { id: 30n },
      data: expect.objectContaining({ attributes: ATTRIBUTES }),
    });
  });

  it('blocks publishing when the saved property schema is stale', async () => {
    const fixture = createFixture({
      attributes: ATTRIBUTES,
      attributesFingerprint: 'b'.repeat(64),
    });
    fixture.prisma.productCategoryPropertyMapping.findMany.mockResolvedValue([
      {
        shopId: 9n,
        categoryId: '20001',
        schemaFingerprint: 'old',
        values: { '2176': [{ value: 111, name: '棉', diyType: 0 }] },
      },
    ]);
    fixture.prisma.shopCategory.findMany.mockResolvedValue([
      { shopId: 9n, categoryId: '20001', attributesFingerprint: 'b'.repeat(64) },
    ]);

    await expect(
      fixture.service.buildPublishSnapshot(1n, 2n, [{ shopId: 9n, categoryId: '20001' }]),
    ).rejects.toThrow('尚未确认或已失效');
  });
});

function createFixture(catalogOverrides: Record<string, unknown>) {
  const catalog = {
    id: 30n,
    shopId: 9n,
    categoryId: '20001',
    isLeaf: true,
    enabled: true,
    ...catalogOverrides,
  };
  const prisma = {
    shop: { findFirst: vi.fn().mockResolvedValue(SHOP) },
    sourceProduct: { findUnique: vi.fn().mockResolvedValue(PRODUCT) },
    productCategoryMapping: { findUnique: vi.fn().mockResolvedValue(CATEGORY) },
    shopCategory: {
      findFirst: vi.fn().mockResolvedValue(catalog),
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    productCategoryPropertyMapping: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const getCategoryAttributes = vi.fn().mockResolvedValue(ATTRIBUTES);
  const adapters = {
    assertAllowed: vi.fn(),
    create: vi.fn().mockReturnValue({ getCategoryAttributes }),
  } as unknown as PlatformAdapterFactory;
  return {
    service: new CategoryPropertyService(
      prisma as unknown as PrismaService,
      adapters,
      {} as ShopTokenService,
    ),
    prisma,
    getCategoryAttributes,
  };
}
