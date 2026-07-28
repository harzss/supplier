import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { CategoryQualificationService } from './category-qualification.service';

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
const CATEGORY = { categoryId: '20001', categoryName: 'T恤' };
const QUALIFICATIONS = [
  {
    key: '9001',
    name: '质检报告',
    hints: ['请上传清晰报告'],
    required: false,
    rules: [
      {
        clauses: [{ propertyId: '2176', propertyValues: ['111'], operand: 'equal' as const }],
        required: true,
      },
    ],
  },
];
const PROPERTY_VALUES = { '2176': [{ value: 111, name: '棉', diyType: 0 }] };

describe('CategoryQualificationService', () => {
  it('loads official rules and marks a dynamically required qualification as missing', async () => {
    const fixture = createFixture({ qualifications: null, qualificationsFingerprint: null });

    const result = await fixture.service.get(1n, 'mock-1001', '9');

    expect(fixture.getCategoryQualifications).toHaveBeenCalledWith('mock-token', '20001');
    expect(fixture.prisma.shopCategory.update).toHaveBeenCalledWith({
      where: { id: 30n },
      data: expect.objectContaining({
        qualifications: QUALIFICATIONS,
        qualificationsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(result.qualifications[0]).toMatchObject({
      key: '9001',
      required: true,
      requiredReason: 'property',
    });
    expect(result.confirmed).toBe(false);
    expect(result.blockers).toContain('请上传必填资质：质检报告');
  });

  it('stores only official qualification metadata with public HTTPS attachments', async () => {
    const fixture = createFixture({
      qualifications: QUALIFICATIONS,
      qualificationsFingerprint: 'a'.repeat(64),
      qualificationsSyncedAt: new Date('2026-07-20T10:00:00.000Z'),
    });
    fixture.prisma.productCategoryQualificationMapping.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        categoryId: '20001',
        schemaFingerprint: 'a'.repeat(64),
        requirementFingerprint: expect.any(String),
        values: [],
        confirmedAt: new Date('2026-07-20T10:10:00.000Z'),
      });

    await fixture.service.confirm(1n, 'mock-1001', {
      shopId: '9',
      qualifications: [
        {
          qualificationKey: '9001',
          qualityContentName: '2026 年质检报告',
          attachmentUrls: ['https://cdn.example.com/quality.jpg'],
        },
      ],
    });

    expect(fixture.prisma.productCategoryQualificationMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          categoryId: '20001',
          schemaFingerprint: 'a'.repeat(64),
          values: [
            {
              qualityKey: '9001',
              qualityName: '质检报告',
              qualityContentName: '2026 年质检报告',
              qualityId: 9001,
              attachments: [{ mediaType: 1, url: 'https://cdn.example.com/quality.jpg' }],
            },
          ],
        }),
      }),
    );
  });

  it('rejects local, private and non-HTTPS qualification attachment URLs', async () => {
    const fixture = createFixture({
      qualifications: QUALIFICATIONS,
      qualificationsFingerprint: 'a'.repeat(64),
      qualificationsSyncedAt: new Date('2026-07-20T10:00:00.000Z'),
    });

    for (const url of [
      'http://cdn.example.com/quality.jpg',
      'https://localhost/quality.jpg',
      'https://192.168.1.10/quality.jpg',
      'data:image/png;base64,abc',
    ]) {
      await expect(
        fixture.service.confirm(1n, 'mock-1001', {
          shopId: '9',
          qualifications: [{ qualificationKey: '9001', attachmentUrls: [url] }],
        }),
      ).rejects.toThrow('公开可访问的 HTTPS URL');
    }
    expect(fixture.prisma.productCategoryQualificationMapping.upsert).not.toHaveBeenCalled();
  });
});

function createFixture(catalogOverrides: Record<string, unknown>) {
  const catalog = {
    id: 30n,
    shopId: 9n,
    categoryId: '20001',
    isLeaf: true,
    enabled: true,
    attributesFingerprint: 'p'.repeat(64),
    attributes: [{ id: '2176', name: '材质' }],
    ...catalogOverrides,
  };
  const prisma = {
    shop: { findFirst: vi.fn().mockResolvedValue(SHOP) },
    sourceProduct: { findUnique: vi.fn().mockResolvedValue(PRODUCT) },
    productCategoryMapping: { findUnique: vi.fn().mockResolvedValue(CATEGORY) },
    shopCategory: {
      findFirst: vi.fn().mockResolvedValue(catalog),
      update: vi.fn().mockResolvedValue({}),
    },
    productCategoryPropertyMapping: {
      findUnique: vi.fn().mockResolvedValue({
        categoryId: '20001',
        schemaFingerprint: 'p'.repeat(64),
        values: PROPERTY_VALUES,
      }),
    },
    productCategoryQualificationMapping: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const getCategoryQualifications = vi.fn().mockResolvedValue(QUALIFICATIONS);
  const adapters = {
    assertAllowed: vi.fn(),
    create: vi.fn().mockReturnValue({ getCategoryQualifications }),
  } as unknown as PlatformAdapterFactory;
  return {
    service: new CategoryQualificationService(
      prisma as unknown as PrismaService,
      adapters,
      {} as ShopTokenService,
    ),
    prisma,
    getCategoryQualifications,
  };
}
