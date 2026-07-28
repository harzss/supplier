import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { FavoriteService } from './favorite.service';

describe('FavoriteService', () => {
  it('lists user favorites as product comparison rows', async () => {
    const prisma = {
      userFavorite: {
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: new Date('2026-07-16T08:00:00.000Z'),
            sourceProduct: product(),
          },
        ]),
      },
    } as unknown as PrismaService;
    const service = new FavoriteService(prisma);

    const result = await service.list(1n);

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      productId1688: 'mock-1001',
      price: '18.9',
      favoritedAt: '2026-07-16T08:00:00.000Z',
      score: { overall: 88 },
    });
  });

  it('adds a favorite idempotently', async () => {
    const upsert = vi.fn().mockResolvedValue({
      createdAt: new Date('2026-07-16T08:00:00.000Z'),
    });
    const prisma = {
      sourceProduct: { findUnique: vi.fn().mockResolvedValue(product()) },
      userFavorite: { upsert },
    } as unknown as PrismaService;
    const service = new FavoriteService(prisma);

    await service.add(1n, 'mock-1001');

    expect(upsert).toHaveBeenCalledWith({
      where: { userId_sourceProductId: { userId: 1n, sourceProductId: 10n } },
      create: { userId: 1n, sourceProductId: 10n },
      update: {},
    });
  });

  it('rejects an unknown source product', async () => {
    const prisma = {
      sourceProduct: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new FavoriteService(prisma);

    await expect(service.add(1n, 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a favorite idempotently', async () => {
    const prisma = {
      userFavorite: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as PrismaService;
    const service = new FavoriteService(prisma);

    await expect(service.remove(1n, 'mock-1001')).resolves.toEqual({ removed: false });
  });
});

function product() {
  return {
    id: 10n,
    productId1688: 'mock-1001',
    title: '纯棉短袖',
    price: { toString: () => '18.9' },
    priceMin: null,
    priceMax: null,
    mainImage: 'https://example.com/product.jpg',
    categoryPath: '女装 > T恤',
    categoryL1: '女装',
    categoryL2: 'T恤',
    monthlySold: 2300,
    isOnePieceDrop: true,
    availability: 'available',
    totalStock: 100,
    availabilityChangedAt: new Date('2026-07-16T00:00:00.000Z'),
    syncedAt: new Date('2026-07-16T00:00:00.000Z'),
    score: {
      overallScore: 88,
      demandScore: 90,
      competitionScore: 70,
      profitScore: 86,
      complianceScore: 95,
      trendScore: 89,
      reason: ['趋势稳定'],
    },
  };
}
