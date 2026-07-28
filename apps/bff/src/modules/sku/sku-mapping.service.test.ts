import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { SkuMappingService } from './sku-mapping.service';
import { buildSkuSuggestion } from './sku-normalizer';

const SKU_LIST = [
  {
    skuId: 'sku-1',
    specName: '米白/M',
    price: 10,
    stock: 12,
    attributes: { 颜色: '米白', 尺码: 'M' },
  },
  {
    skuId: 'sku-2',
    specName: '黑色/L',
    price: 12,
    stock: 8,
    attributes: { 颜色: '黑色', 尺码: 'L' },
  },
];

const PRODUCT = {
  id: 2n,
  productId1688: 'mock-1001',
  title: '纯棉短袖 T 恤',
  price: 10,
  skuList: SKU_LIST,
};

describe('SkuMappingService', () => {
  it('returns an auto-filled but unconfirmed mapping', async () => {
    const fixture = createFixture();
    const result = await fixture.service.get(1n, 'mock-1001', 'douyin');

    expect(result).toMatchObject({
      confirmed: false,
      stale: false,
      requiresConfirmation: true,
      dimensions: ['颜色', '尺码'],
    });
    expect(result.skus).toHaveLength(2);
  });

  it('persists a user-confirmed mapping with the current source fingerprint', async () => {
    const fixture = createFixture();
    const fingerprint = buildSkuSuggestion(SKU_LIST, 10).sourceFingerprint;
    fixture.prisma.productSkuMapping.upsert.mockResolvedValue({
      dimensions: ['颜色', '尺码'],
      skus: [
        { sourceSkuId: 'sku-1', values: ['奶白', 'M'], enabled: true },
        { sourceSkuId: 'sku-2', values: ['黑色', 'L'], enabled: false },
      ],
      sourceFingerprint: fingerprint,
      confirmedAt: new Date('2026-07-16T12:00:00.000Z'),
    });

    const result = await fixture.service.confirm(1n, 'mock-1001', {
      platform: 'douyin',
      dimensions: ['颜色', '尺码'],
      skus: [
        { sourceSkuId: 'sku-1', values: ['奶白', 'M'], enabled: true },
        { sourceSkuId: 'sku-2', values: ['黑色', 'L'], enabled: false },
      ],
    });

    expect(fixture.prisma.productSkuMapping.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sourceFingerprint: fingerprint }),
        update: expect.objectContaining({ sourceFingerprint: fingerprint }),
      }),
    );
    expect(result.confirmed).toBe(true);
    expect(result.skus[0]?.values).toEqual(['奶白', 'M']);
  });

  it('rejects duplicate enabled SKU combinations', async () => {
    const fixture = createFixture();
    await expect(
      fixture.service.confirm(1n, 'mock-1001', {
        platform: 'douyin',
        dimensions: ['颜色', '尺码'],
        skus: [
          { sourceSkuId: 'sku-1', values: ['白色', 'M'], enabled: true },
          { sourceSkuId: 'sku-2', values: ['白色', 'M'], enabled: true },
        ],
      }),
    ).rejects.toThrow('规格组合不能重复');
  });

  it('marks a saved mapping stale when the source SKU fingerprint changes', async () => {
    const fixture = createFixture();
    fixture.prisma.productSkuMapping.findUnique.mockResolvedValue({
      dimensions: ['颜色', '尺码'],
      skus: [
        { sourceSkuId: 'sku-1', values: ['米白', 'M'], enabled: true },
        { sourceSkuId: 'sku-2', values: ['黑色', 'L'], enabled: true },
      ],
      sourceFingerprint: 'outdated-fingerprint',
      confirmedAt: new Date(),
    });

    const result = await fixture.service.get(1n, 'mock-1001', 'douyin');

    expect(result.confirmed).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.warnings[0]).toContain('之前的确认已失效');
  });
});

function createFixture() {
  const prisma = {
    sourceProduct: { findUnique: vi.fn().mockResolvedValue(PRODUCT) },
    productSkuMapping: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return {
    service: new SkuMappingService(prisma as unknown as PrismaService),
    prisma,
  };
}
