import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from '../observability/alert.service';
import type { OrderSyncService } from './order-sync.service';
import { OrderSyncWorker } from './order-sync.worker';

describe('OrderSyncWorker', () => {
  it('syncs every active real Douyin seller shop and continues after one failure', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 9n, userId: 1n, user: { entitlementRevision: 7 } },
      { id: 10n, userId: 2n, user: { entitlementRevision: 8 } },
    ]);
    const syncShop = vi
      .fn()
      .mockResolvedValueOnce({ shopId: '9', synced: 1, skipped: 0 })
      .mockRejectedValueOnce(new Error('platform unavailable'));
    const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
    const worker = new OrderSyncWorker(
      { get: vi.fn() } as unknown as ConfigService,
      { shop: { findMany } } as unknown as PrismaService,
      { syncShop } as unknown as OrderSyncService,
      alerts,
    );

    const result = await worker.runOnce();

    expect(findMany).toHaveBeenCalledWith({
      where: {
        platform: 'douyin',
        role: 'seller',
        status: 'active',
        accessTokenEnc: { not: null },
        user: { status: 'active', entitlementAccessStatus: 'active' },
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      orderBy: [{ lastOrderSyncAt: 'asc' }, { id: 'asc' }],
      select: { id: true, userId: true, user: { select: { entitlementRevision: true } } },
    });
    expect(syncShop).toHaveBeenNthCalledWith(1, 1n, 9n, 7);
    expect(syncShop).toHaveBeenNthCalledWith(2, 2n, 10n, 8);
    expect(result).toEqual({ attempted: 2, succeeded: 1, busy: 0, failed: 1 });
    expect(alerts.resolve).toHaveBeenCalledWith('order_sync.shop.9', {
      synced: 1,
      skipped: 0,
    });
    expect(alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'order_sync.shop.10',
        type: 'order_sync',
        severity: 'warning',
      }),
    );
  });

  it('treats a distributed-lock collision as normal busy work instead of an alert', async () => {
    const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
    const worker = new OrderSyncWorker(
      { get: vi.fn() } as unknown as ConfigService,
      {
        shop: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: 9n, userId: 1n, user: { entitlementRevision: 7 } }]),
        },
      } as unknown as PrismaService,
      {
        syncShop: vi
          .fn()
          .mockRejectedValue(new ServiceUnavailableException('该店铺订单正在同步，请稍后重试')),
      } as unknown as OrderSyncService,
      alerts,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      busy: 1,
      failed: 0,
    });
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('treats a superseded sync attempt as busy instead of raising a stale warning', async () => {
    const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
    const worker = new OrderSyncWorker(
      { get: vi.fn() } as unknown as ConfigService,
      {
        shop: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: 9n, userId: 1n, user: { entitlementRevision: 7 } }]),
        },
      } as unknown as PrismaService,
      {
        syncShop: vi
          .fn()
          .mockRejectedValue(
            new ServiceUnavailableException('订单同步执行权已失效，请由当前任务继续'),
          ),
      } as unknown as OrderSyncService,
      alerts,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 1,
      succeeded: 0,
      busy: 1,
      failed: 0,
    });
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('does not select a suspended user shop as a worker candidate', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const syncShop = vi.fn();
    const worker = new OrderSyncWorker(
      { get: vi.fn() } as unknown as ConfigService,
      { shop: { findMany } } as unknown as PrismaService,
      { syncShop } as unknown as OrderSyncService,
      { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      busy: 0,
      failed: 0,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          user: { status: 'active', entitlementAccessStatus: 'active' },
        }),
      }),
    );
    expect(syncShop).not.toHaveBeenCalled();
  });
});
