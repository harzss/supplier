import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { normalizeScoreReasons, ProductService } from './product.service';

describe('ProductService filters', () => {
  it('normalizes untrusted score reason JSON before returning products', () => {
    expect(normalizeScoreReasons(['趋势稳定', null, { text: '高转化' }, '', '库存充足'])).toEqual([
      '趋势稳定',
      '库存充足',
    ]);
    expect(normalizeScoreReasons({ text: 'not-an-array' })).toEqual([]);
  });

  it('combines category and decimal price filters in one recommendation query', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new ProductService({ sourceProduct: { findMany } } as unknown as PrismaService);

    await service.getDailyRecommendations({
      categoryL1: ' 女装 ',
      priceMin: 10.5,
      priceMax: 30.25,
      limit: 30,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          availability: 'available',
          score: { isNot: null },
          categoryL1: '女装',
          price: { gte: 10.5, lte: 30.25 },
        },
        take: 30,
      }),
    );
  });

  it('rejects an inverted price range before querying the database', async () => {
    const findMany = vi.fn();
    const service = new ProductService({ sourceProduct: { findMany } } as unknown as PrismaService);

    await expect(
      service.getDailyRecommendations({ priceMin: 50, priceMax: 10, limit: 30 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('builds dynamic category counts and a global price range with one grouped query', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      {
        categoryL1: '家居',
        _count: { _all: 8 },
        _min: { price: 12.5 },
        _max: { price: 55.96 },
      },
      {
        categoryL1: '女装',
        _count: { _all: 10 },
        _min: { price: 16.9 },
        _max: { price: 48.19 },
      },
      {
        categoryL1: null,
        _count: { _all: 1 },
        _min: { price: 4.5 },
        _max: { price: 4.5 },
      },
    ]);
    const service = new ProductService({ sourceProduct: { groupBy } } as unknown as PrismaService);

    await expect(service.getFacets()).resolves.toEqual({
      categories: [
        { name: '女装', count: 10 },
        { name: '家居', count: 8 },
      ],
      priceRange: { min: 4.5, max: 55.96 },
    });
    expect(groupBy).toHaveBeenCalledOnce();
  });

  it('marks recommendation database failures as degraded instead of normal empty data', async () => {
    const service = new ProductService({
      sourceProduct: { findMany: vi.fn().mockRejectedValue(new Error('db unavailable')) },
    } as unknown as PrismaService);

    await expect(service.getDailyRecommendations({ limit: 30 })).resolves.toEqual({
      total: 0,
      items: [],
      degraded: true,
    });
  });

  it('returns 404 only when the product query succeeds with no record', async () => {
    const service = new ProductService({
      sourceProduct: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService);

    await expect(service.getDetail('missing-product')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('propagates product-detail database failures instead of reporting 404', async () => {
    const service = new ProductService({
      sourceProduct: { findUnique: vi.fn().mockRejectedValue(new Error('db unavailable')) },
    } as unknown as PrismaService);

    await expect(service.getDetail('1688-1')).rejects.toThrow('db unavailable');
  });
});
