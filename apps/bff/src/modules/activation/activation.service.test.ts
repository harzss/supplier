import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { ActivationService } from './activation.service';

describe('ActivationService', () => {
  it('returns the first actionable step when no activation facts exist', async () => {
    const { prisma, mocks } = fixture();
    const service = new ActivationService(prisma, config('supabase'));

    const result = await service.get(42n);

    expect(result).toMatchObject({
      currentStep: 'connect_shop',
      nextHref: '/settings#shops',
      completedSteps: 0,
      totalSteps: 4,
    });
    expect(result.steps.map((step) => step.completedAt)).toEqual([null, null, null, null]);
    expect(mocks.shopFindMany).toHaveBeenCalledWith({
      where: {
        userId: 42n,
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, createdAt: true },
    });
    expect(mocks.pricingFindFirst).toHaveBeenCalledWith({
      where: {
        userId: 42n,
        action: 'publish.pricing.preview',
        outcome: 'success',
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    expect(mocks.publishedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          platformProductId: { not: null },
          task: { userId: 42n },
          shop: {
            userId: 42n,
            role: 'seller',
            NOT: { platformShopId: { startsWith: 'demo-' } },
          },
        },
      }),
    );
  });

  it('prefers a successful product view over a favorite for the selected product', async () => {
    const { prisma } = fixture({
      shops: [{ id: 9n, status: 'active', createdAt: date('2026-08-01T08:00:00.000Z') }],
      productView: {
        resourceId: 'viewed-1002',
        createdAt: date('2026-08-01T09:00:00.000Z'),
      },
      favorite: {
        createdAt: date('2026-08-01T07:00:00.000Z'),
        sourceProduct: { productId1688: 'favorite-1001' },
      },
    });
    const service = new ActivationService(prisma, config('supabase'));

    const result = await service.get(42n);

    expect(result.currentStep).toBe('preview_pricing');
    expect(result.steps[1]).toMatchObject({
      key: 'select_product',
      completedAt: '2026-08-01T09:00:00.000Z',
      readyNow: true,
    });
    expect(result.steps[2]?.href).toBe('/products?id=viewed-1002#publish');
  });

  it('uses the favorite as a durable-data fallback when no view audit exists', async () => {
    const { prisma } = fixture({
      favorite: {
        createdAt: date('2026-08-01T07:00:00.000Z'),
        sourceProduct: { productId1688: 'favorite/1001' },
      },
    });
    const service = new ActivationService(prisma, config('supabase'));

    const result = await service.get(42n);

    expect(result.steps[1]?.completedAt).toBe('2026-08-01T07:00:00.000Z');
    expect(result.steps[2]?.href).toBe('/products?id=favorite%2F1001#publish');
  });

  it('retains historical shop completion while requiring an active seller connection', async () => {
    const { prisma } = fixture({
      shops: [{ id: 9n, status: 'revoked', createdAt: date('2026-07-30T08:00:00.000Z') }],
      productView: {
        resourceId: '1001',
        createdAt: date('2026-07-30T09:00:00.000Z'),
      },
      pricingPreview: { createdAt: date('2026-07-30T10:00:00.000Z') },
      publishedProduct: { publishedAt: date('2026-07-30T11:00:00.000Z') },
    });
    const service = new ActivationService(prisma, config('supabase'));

    const result = await service.get(42n);

    expect(result.currentStep).toBe('connect_shop');
    expect(result.completedSteps).toBe(3);
    expect(result.steps[0]).toMatchObject({
      completedAt: '2026-07-30T08:00:00.000Z',
      readyNow: false,
    });
  });

  it('resumes an existing visible publish task from the task center', async () => {
    const { prisma } = fixture({
      shops: [{ id: 9n, status: 'active', createdAt: date('2026-08-01T08:00:00.000Z') }],
      productView: {
        resourceId: '1001',
        createdAt: date('2026-08-01T09:00:00.000Z'),
      },
      pricingPreview: { createdAt: date('2026-08-01T10:00:00.000Z') },
      publishTasks: [{ targetShopIds: ['9'] }],
    });
    const service = new ActivationService(prisma, config('supabase'));

    const result = await service.get(42n);

    expect(result.currentStep).toBe('publish_product');
    expect(result.nextHref).toBe('/published');
    expect(result.steps[3]?.href).toBe('/published');
  });

  it('completes the flow and permits demo shops only in demo auth mode', async () => {
    const { prisma, mocks } = fixture({
      shops: [{ id: 9n, status: 'active', createdAt: date('2026-08-01T08:00:00.000Z') }],
      productView: {
        resourceId: '1001',
        createdAt: date('2026-08-01T09:00:00.000Z'),
      },
      pricingPreview: { createdAt: date('2026-08-01T10:00:00.000Z') },
      publishedProduct: { publishedAt: date('2026-08-01T11:00:00.000Z') },
    });
    const service = new ActivationService(prisma, config('demo'));

    const result = await service.get(42n);

    expect(result).toMatchObject({
      currentStep: null,
      nextHref: '/published',
      completedSteps: 4,
      totalSteps: 4,
    });
    expect(result.steps.every((step) => step.readyNow)).toBe(true);
    expect(mocks.shopFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 42n, role: 'seller' } }),
    );
    expect(mocks.publishedFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          platformProductId: { not: null },
          task: { userId: 42n },
          shop: { userId: 42n, role: 'seller' },
        },
      }),
    );
  });
});

interface FixtureValues {
  shops: Array<{ id: bigint; status: string; createdAt: Date }>;
  productView: { resourceId: string | null; createdAt: Date } | null;
  favorite: {
    createdAt: Date;
    sourceProduct: { productId1688: string };
  } | null;
  pricingPreview: { createdAt: Date } | null;
  publishTasks: Array<{ targetShopIds: unknown }>;
  publishedProduct: { publishedAt: Date } | null;
}

function fixture(values: Partial<FixtureValues> = {}) {
  const shopFindMany = vi.fn().mockResolvedValue(values.shops ?? []);
  const productViewFindFirst = vi.fn().mockResolvedValue(values.productView ?? null);
  const pricingFindFirst = vi.fn().mockResolvedValue(values.pricingPreview ?? null);
  const favoriteFindFirst = vi.fn().mockResolvedValue(values.favorite ?? null);
  const publishTaskFindMany = vi.fn().mockResolvedValue(values.publishTasks ?? []);
  const publishedFindFirst = vi.fn().mockResolvedValue(values.publishedProduct ?? null);
  const prisma = {
    shop: { findMany: shopFindMany },
    auditLog: {
      findFirst: vi
        .fn()
        .mockImplementationOnce(productViewFindFirst)
        .mockImplementationOnce(pricingFindFirst),
    },
    userFavorite: { findFirst: favoriteFindFirst },
    publishTask: { findMany: publishTaskFindMany },
    publishedProduct: { findFirst: publishedFindFirst },
  } as unknown as PrismaService;
  return {
    prisma,
    mocks: {
      shopFindMany,
      productViewFindFirst,
      pricingFindFirst,
      favoriteFindFirst,
      publishTaskFindMany,
      publishedFindFirst,
    },
  };
}

function config(mode: 'demo' | 'supabase'): ConfigService {
  return {
    get: vi.fn((key: string) => (key === 'AUTH_MODE' ? mode : undefined)),
  } as unknown as ConfigService;
}

function date(value: string): Date {
  return new Date(value);
}
