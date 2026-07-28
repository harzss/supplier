import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  it('aggregates effective GMV and separates confirmed from estimated costs', async () => {
    const prisma = fixture([
      order({ id: 1n, status: 'shipped', amount: 100, purchaseCost: 40, quantity: 2 }),
      order({ id: 2n, status: 'paid', amount: 50, costPrice: 10, quantity: 2 }),
      order({ id: 3n, status: 'refunded', amount: 30, costPrice: null }),
      order({ id: 4n, status: 'closed', amount: 20, costPrice: null }),
    ]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.range.startAt).toBe('2026-06-16T16:00:00.000Z');
    expect(result.kpis).toMatchObject({
      effectiveGmv: 150,
      refundedAmount: 30,
      validOrders: 2,
      averageOrderValue: 75,
      estimatedGrossProfit: 90,
      estimatedGrossMargin: 0.6,
      cost: {
        total: 60,
        confirmed: 40,
        estimated: 20,
        uncostedOrders: 0,
        coverageRate: 1,
      },
    });
    expect(result.products[0]).toMatchObject({ effectiveGmv: 150, quantity: 4 });
    expect(result.productPerformance).toMatchObject({
      summary: { onlineProducts: 1, sellingProducts: 1, slowProducts: 0 },
      hot: [{ publishedProductId: '10', validOrders: 2, quantity: 4 }],
    });
    expect(result.statuses.find((item) => item.status === 'refunded')).toEqual({
      status: 'refunded',
      count: 1,
      amount: 30,
    });
    expect(result.daily).toHaveLength(30);
  });

  it('does not claim profit when an effective order has no cost basis', async () => {
    const prisma = fixture([order({ id: 5n, status: 'paid', amount: 10, costPrice: null })]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 7, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.kpis.estimatedGrossProfit).toBeNull();
    expect(result.kpis.cost).toMatchObject({
      total: null,
      uncostedOrders: 1,
      coverageRate: 0,
    });
  });

  it('uses confirmed refund amounts and excludes unreconciled refunds from financial totals', async () => {
    const fingerprint = 'a'.repeat(64);
    const prisma = fixture([
      order({
        id: 6n,
        status: 'shipped',
        amount: 100,
        purchaseCost: 40,
        successfulRefund: true,
        refundAmount: 20,
        refundAmountFingerprint: fingerprint,
        partialRefundFingerprint: fingerprint,
      }),
      order({
        id: 7n,
        status: 'paid',
        amount: 60,
        successfulRefund: true,
      }),
    ]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.kpis).toMatchObject({
      effectiveGmv: 80,
      refundedAmount: 20,
      validOrders: 1,
      unreconciledRefundOrders: 1,
      unreconciledGrossAmount: 60,
      averageOrderValue: 80,
      estimatedGrossProfit: 40,
    });
    expect(result.products[0]).toMatchObject({ effectiveGmv: 80, validOrders: 1 });
  });

  it('uses reconciled purchase costs for partial and full refunds', async () => {
    const fingerprint = 'b'.repeat(64);
    const prisma = fixture([
      order({
        id: 8n,
        status: 'refunded',
        amount: 50,
        purchaseCost: 30,
        purchaseExceptionStatus: 'resolved',
        reconciledCost: 7,
      }),
      order({
        id: 9n,
        status: 'shipped',
        amount: 100,
        successfulRefund: true,
        refundAmount: 20,
        refundAmountFingerprint: fingerprint,
        partialRefundFingerprint: fingerprint,
        purchaseCost: 40,
        purchaseExceptionStatus: 'resolved',
        reconciledCost: 10,
      }),
    ]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.kpis).toMatchObject({
      effectiveGmv: 80,
      refundedAmount: 70,
      validOrders: 1,
      estimatedGrossProfit: 63,
      cost: { total: 17, confirmed: 17, uncostedOrders: 0, coverageRate: 1 },
    });
  });

  it('includes costs from archived failed attempts in an active replacement purchase', async () => {
    const prisma = fixture([
      order({
        id: 12n,
        status: 'shipped',
        amount: 100,
        purchaseCost: 40,
        priorIncurredCost: 5,
      }),
    ]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.kpis).toMatchObject({
      effectiveGmv: 100,
      estimatedGrossProfit: 55,
      cost: { total: 45, confirmed: 45, uncostedOrders: 0, coverageRate: 1 },
    });
  });

  it('does not claim profit while a remote purchase exception lacks final cost', async () => {
    const prisma = fixture([
      order({
        id: 10n,
        status: 'refunded',
        amount: 50,
        purchaseCost: 30,
        purchaseExceptionStatus: 'action_required',
      }),
    ]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.kpis).toMatchObject({
      effectiveGmv: 0,
      refundedAmount: 50,
      estimatedGrossProfit: null,
      cost: { total: null, uncostedOrders: 1, coverageRate: 0 },
    });
  });

  it('treats a locally stopped purchase as zero incurred cost', async () => {
    const prisma = fixture([
      order({
        id: 11n,
        status: 'closed',
        amount: 50,
        purchaseCost: 30,
        purchaseExceptionStatus: 'stopped',
        orderId1688: null,
        purchaseStatus: 'pending',
      }),
    ]);
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.kpis).toMatchObject({
      effectiveGmv: 0,
      estimatedGrossProfit: 0,
      cost: { total: 0, confirmed: 0, uncostedOrders: 0, coverageRate: 1 },
    });
  });

  it('marks only mature products without effective orders as slow-moving', async () => {
    const prisma = fixture(
      [],
      [
        product({ id: 11n, publishedAt: '2026-07-01T08:00:00.000Z' }),
        product({ id: 12n, publishedAt: '2026-07-15T08:00:00.000Z' }),
      ],
    );
    const service = new AnalyticsService(prisma, authConfig());

    const result = await service.overview(1n, 30, new Date('2026-07-16T12:00:00.000Z'));

    expect(result.productPerformance.summary).toEqual({
      onlineProducts: 2,
      eligibleProducts: 1,
      sellingProducts: 0,
      slowProducts: 1,
      activityRate: 0,
      graceDays: 7,
    });
    expect(result.productPerformance.hot).toEqual([]);
    expect(result.productPerformance.slow).toHaveLength(1);
    expect(result.productPerformance.slow[0]).toMatchObject({
      publishedProductId: '11',
      validOrders: 0,
      lastPaidAt: null,
    });
  });

  it('excludes legacy demo shops from production analytics', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { shop: { findMany } } as unknown as PrismaService;
    const service = new AnalyticsService(prisma, authConfig('supabase'));

    await service.overview(1n, 7, new Date('2026-07-16T12:00:00.000Z'));

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 1n,
          NOT: { platformShopId: { startsWith: 'demo-' } },
        },
      }),
    );
  });
});

function authConfig(authMode: 'demo' | 'supabase' = 'demo'): ConfigService {
  return { get: (key: string) => (key === 'AUTH_MODE' ? authMode : undefined) } as ConfigService;
}

function fixture(
  orders: ReturnType<typeof order>[],
  products: ReturnType<typeof product>[] = [
    product({
      id: 10n,
      publishedAt: '2026-07-01T08:00:00.000Z',
      lastPaidAt: '2026-07-15T08:00:00.000Z',
    }),
  ],
): PrismaService {
  return {
    shop: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 1n,
          shopName: '测试店',
          platform: 'douyin',
          orders: orders.map(({ shop: _shop, ...order }) => order),
          publishedProducts: products.map(({ shop: _shop, ...product }) => product),
        },
      ]),
    },
  } as unknown as PrismaService;
}

function product(options: { id: bigint; publishedAt: string; lastPaidAt?: string }) {
  return {
    id: options.id,
    title: `测试商品 ${options.id.toString()}`,
    publishedAt: new Date(options.publishedAt),
    shop: { id: 1n, shopName: '测试店', platform: 'douyin' },
    orders: options.lastPaidAt ? [{ paidAt: new Date(options.lastPaidAt) }] : [],
  };
}

function order(options: {
  id: bigint;
  status: string;
  amount: number;
  purchaseCost?: number;
  costPrice?: number | null;
  quantity?: number;
  successfulRefund?: boolean;
  refundAmount?: number | null;
  refundAmountFingerprint?: string | null;
  partialRefundFingerprint?: string | null;
  purchaseExceptionStatus?: 'none' | 'stopped' | 'action_required' | 'resolved';
  reconciledCost?: number | null;
  priorIncurredCost?: number;
  orderId1688?: string | null;
  purchaseStatus?: string;
}) {
  return {
    id: options.id,
    amount: options.amount,
    status: options.status,
    afterSaleStatus: options.successfulRefund ? 'partial_refund' : 'none',
    partialRefundFingerprint: options.partialRefundFingerprint ?? null,
    refundAmount: options.refundAmount ?? null,
    refundAmountFingerprint: options.refundAmountFingerprint ?? null,
    paidAt: new Date('2026-07-15T08:00:00.000Z'),
    skuInfo: [{ quantity: options.quantity ?? 1 }],
    items: options.successfulRefund ? [{ refundStatusRaw: 3 }] : [],
    shop: { id: 1n, shopName: '测试店', platform: 'douyin' },
    publishedProduct:
      options.costPrice === null
        ? null
        : { id: 10n, title: '测试商品', costPrice: options.costPrice ?? 25 },
    purchaseOrders:
      options.purchaseCost === undefined
        ? []
        : [
            {
              purchaseCost: options.purchaseCost,
              priorIncurredCost: options.priorIncurredCost ?? 0,
              reconciledCost: options.reconciledCost ?? null,
              exceptionStatus: options.purchaseExceptionStatus ?? 'none',
              orderId1688: options.orderId1688 === undefined ? '1688-order' : options.orderId1688,
              status: options.purchaseStatus ?? 'paid',
            },
          ],
  };
}
