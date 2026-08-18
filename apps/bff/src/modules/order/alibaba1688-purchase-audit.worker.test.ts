import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from '../observability/alert.service';
import { Alibaba1688PurchaseAuditWorker } from './alibaba1688-purchase-audit.worker';
import type { Alibaba1688PurchaseService } from './alibaba1688-purchase.service';

describe('Alibaba1688PurchaseAuditWorker', () => {
  it('checks settled purchases and raises distinct anomaly and execution alerts', async () => {
    const candidates = [1n, 2n, 3n, 4n].map((id) => ({
      id,
      orderId: id + 10n,
      settledAuditNextAt: null,
      exceptionStatus: 'none' as const,
      exceptionRevision: 0,
      order: { shop: { userId: 1n, user: { entitlementRevision: 7 } } },
    }));
    const findMany = vi.fn().mockResolvedValue(candidates);
    const findUnique = vi.fn().mockResolvedValue({
      exceptionStatus: 'action_required',
      exceptionRevision: 1,
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditSettledPurchase = vi
      .fn()
      .mockResolvedValueOnce('checked')
      .mockResolvedValueOnce('action_required')
      .mockResolvedValueOnce('skipped')
      .mockRejectedValueOnce(new Error('platform unavailable'));
    const raise = vi.fn().mockResolvedValue(undefined);
    const resolve = vi.fn().mockResolvedValue(undefined);
    const worker = new Alibaba1688PurchaseAuditWorker(
      {
        get: (key: string) => (key === 'ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE' ? 25 : undefined),
      } as ConfigService,
      { purchaseOrder: { findMany, findUnique, updateMany } } as unknown as PrismaService,
      { auditSettledPurchase } as unknown as Alibaba1688PurchaseService,
      { raise, resolve } as unknown as AlertService,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 4,
      checked: 1,
      actionRequired: 1,
      skipped: 1,
      failed: 1,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          everShipped: true,
          order: {
            status: { in: ['shipped', 'received'] },
            shop: { user: { status: 'active', entitlementAccessStatus: 'active' } },
          },
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([expect.objectContaining({ settledAuditNextAt: null })]),
            }),
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  exceptionStatus: { in: ['none', 'resolved'] },
                  status: { in: ['shipped', 'received'] },
                }),
                expect.objectContaining({
                  exceptionStatus: 'action_required',
                  status: { in: ['shipped', 'received', 'failed'] },
                }),
              ]),
            }),
          ]),
        }),
        take: 25,
      }),
    );
    expect(updateMany).toHaveBeenCalledTimes(4);
    expect(auditSettledPurchase).toHaveBeenNthCalledWith(1, 1n, 1n, 7);
    expect(resolve).toHaveBeenCalledWith('purchase_audit.purchase.1', {
      purchaseOrderId: 1n,
      orderId: 11n,
    });
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'purchase_audit.purchase.2',
        severity: 'critical',
        details: expect.objectContaining({ exceptionRevision: 1 }),
      }),
    );
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'purchase_audit.purchase.4',
        severity: 'warning',
      }),
    );
  });

  it('retries critical alert delivery for an already flagged purchase without another API audit', async () => {
    const candidate = {
      id: 9n,
      orderId: 19n,
      settledAuditNextAt: new Date('2026-07-22T00:00:00.000Z'),
      exceptionStatus: 'action_required' as const,
      exceptionRevision: 4,
      order: { shop: { userId: 2n, user: { entitlementRevision: 8 } } },
    };
    const auditSettledPurchase = vi.fn();
    const raise = vi.fn().mockResolvedValue(undefined);
    const worker = new Alibaba1688PurchaseAuditWorker(
      { get: () => undefined } as ConfigService,
      {
        purchaseOrder: {
          findMany: vi.fn().mockResolvedValue([candidate]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            exceptionStatus: 'action_required',
            exceptionRevision: 4,
          }),
        },
      } as unknown as PrismaService,
      { auditSettledPurchase } as unknown as Alibaba1688PurchaseService,
      { raise, resolve: vi.fn() } as unknown as AlertService,
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      attempted: 1,
      actionRequired: 1,
      checked: 0,
    });

    expect(auditSettledPurchase).not.toHaveBeenCalled();
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'purchase_audit.purchase.9',
        severity: 'critical',
        details: expect.objectContaining({ exceptionRevision: 4 }),
      }),
    );
  });

  it('does not raise a stale critical alert after the exception is concurrently resolved', async () => {
    const candidate = {
      id: 9n,
      orderId: 19n,
      settledAuditNextAt: new Date('2026-07-22T00:00:00.000Z'),
      exceptionStatus: 'action_required' as const,
      exceptionRevision: 4,
      order: { shop: { userId: 2n, user: { entitlementRevision: 8 } } },
    };
    const raise = vi.fn();
    const resolve = vi.fn().mockResolvedValue(undefined);
    const worker = new Alibaba1688PurchaseAuditWorker(
      { get: () => undefined } as ConfigService,
      {
        purchaseOrder: {
          findMany: vi.fn().mockResolvedValue([candidate]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUnique: vi.fn().mockResolvedValue({
            exceptionStatus: 'resolved',
            exceptionRevision: 4,
          }),
        },
      } as unknown as PrismaService,
      { auditSettledPurchase: vi.fn() } as unknown as Alibaba1688PurchaseService,
      { raise, resolve } as unknown as AlertService,
    );

    await expect(worker.runOnce()).resolves.toMatchObject({
      attempted: 1,
      actionRequired: 0,
      skipped: 1,
    });

    expect(raise).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith('purchase_audit.purchase.9', {
      purchaseOrderId: 9n,
      orderId: 19n,
    });
  });

  it('stops before the adapter when entitlement changes before the claim', async () => {
    const auditSettledPurchase = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const worker = new Alibaba1688PurchaseAuditWorker(
      { get: () => undefined } as ConfigService,
      {
        purchaseOrder: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 5n,
              orderId: 15n,
              settledAuditNextAt: null,
              exceptionStatus: 'none',
              exceptionRevision: 0,
              order: { shop: { userId: 1n, user: { entitlementRevision: 7 } } },
            },
          ]),
          updateMany,
        },
      } as unknown as PrismaService,
      { auditSettledPurchase } as unknown as Alibaba1688PurchaseService,
      { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 0,
      checked: 0,
      actionRequired: 0,
      skipped: 1,
      failed: 0,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: {
            status: { in: ['shipped', 'received'] },
            shop: {
              userId: 1n,
              user: {
                status: 'active',
                entitlementAccessStatus: 'active',
                entitlementRevision: 7,
              },
            },
          },
        }),
      }),
    );
    expect(auditSettledPurchase).not.toHaveBeenCalled();
  });

  it('does not select a settled purchase owned by a suspended user', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const auditSettledPurchase = vi.fn();
    const worker = new Alibaba1688PurchaseAuditWorker(
      { get: () => undefined } as ConfigService,
      { purchaseOrder: { findMany } } as unknown as PrismaService,
      { auditSettledPurchase } as unknown as Alibaba1688PurchaseService,
      { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService,
    );

    await expect(worker.runOnce()).resolves.toEqual({
      attempted: 0,
      checked: 0,
      actionRequired: 0,
      skipped: 0,
      failed: 0,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          order: {
            status: { in: ['shipped', 'received'] },
            shop: { user: { status: 'active', entitlementAccessStatus: 'active' } },
          },
        }),
      }),
    );
    expect(auditSettledPurchase).not.toHaveBeenCalled();
  });
});
