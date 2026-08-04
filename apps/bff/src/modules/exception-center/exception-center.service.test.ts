import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import type { ExceptionCase, ExceptionCaseEvent, Prisma } from '@supplier/db';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AfterSaleService } from '../after-sale/after-sale.service';
import { ExceptionCenterService } from './exception-center.service';

const USER_ID = 42n;
const NOW = new Date('2026-08-05T08:00:00.000Z');

describe('ExceptionCenterService', () => {
  it('lists only the current tenant and exposes status counts', async () => {
    const row = caseFixture();
    const prisma = prismaFixture();
    prisma.exceptionCase.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prisma.exceptionCase.findMany.mockResolvedValue([row]);
    prisma.exceptionCase.groupBy.mockResolvedValue([
      { status: 'open', _count: { _all: 1 } },
      { status: 'resolved', _count: { _all: 2 } },
    ]);
    const service = createService(prisma);

    const result = await service.list(USER_ID, {
      status: 'open',
      domain: 'logistics',
      priority: 'critical',
      q: '物流',
      page: 1,
      pageSize: 30,
    });

    expect(prisma.exceptionCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          status: 'open',
          domain: 'logistics',
          priority: 'critical',
        }),
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      counts: { open: 1, acknowledged: 0, resolved: 2 },
      criticalOpenCount: 1,
      items: [
        expect.objectContaining({
          id: '7',
          title: '销售平台物流回传失败',
          subject: { type: 'order', id: '99', label: '销售订单 A', href: '/orders' },
        }),
      ],
    });
  });

  it('acknowledges with a tenant and revision CAS and appends the command event atomically', async () => {
    const current = caseFixture({ status: 'open', stateRevision: 3 });
    const prisma = prismaFixture();
    prisma.exceptionCaseEvent.findUnique.mockResolvedValue(null);
    prisma.exceptionCase.findFirst.mockResolvedValue(current);
    prisma.exceptionCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.exceptionCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7', status: 'acknowledged' });

    const result = await service.acknowledge(USER_ID, '7', {
      expectedRevision: 3,
      clientRequestId: '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312',
      note: '  已开始核对平台物流  ',
    });

    expect(prisma.exceptionCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7n,
        userId: USER_ID,
        sourceActive: true,
        status: 'open',
        stateRevision: 3,
      },
      data: expect.objectContaining({
        status: 'acknowledged',
        stateRevision: { increment: 1 },
        acknowledgedByUserId: USER_ID,
      }),
    });
    expect(prisma.exceptionCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        caseId: 7n,
        caseRevision: 4,
        type: 'acknowledged',
        actorUserId: USER_ID,
        note: '已开始核对平台物流',
        fromStatus: 'open',
        toStatus: 'acknowledged',
      }),
    });
    expect(result).toEqual({ id: '7', status: 'acknowledged' });
  });

  it('replays the same acknowledgement command without another state transition', async () => {
    const prisma = prismaFixture();
    prisma.exceptionCaseEvent.findUnique.mockResolvedValue(
      eventFixture({
        userId: USER_ID,
        caseId: 7n,
        type: 'acknowledged',
        clientRequestId: '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312',
      }),
    );
    const service = createService(prisma);
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7', status: 'acknowledged' });

    await service.acknowledge(USER_ID, '7', {
      expectedRevision: 1,
      clientRequestId: '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312',
      note: '开始处理',
    });

    expect(prisma.exceptionCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.exceptionCaseEvent.create).not.toHaveBeenCalled();
  });

  it('rejects an acknowledgement note that becomes empty after trimming', async () => {
    const service = createService(prismaFixture());

    await expect(
      service.acknowledge(USER_ID, '7', {
        expectedRevision: 1,
        clientRequestId: '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312',
        note: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('opens a producer case from the allowlist with a stable fingerprint and internal action', async () => {
    const prisma = prismaFixture();
    prisma.exceptionCase.findUnique.mockResolvedValue(null);
    prisma.exceptionCase.create.mockImplementation(async ({ data }) =>
      caseFixture({
        ...data,
        id: 7n,
        createdAt: NOW,
        updatedAt: NOW,
      } as Partial<ExceptionCase>),
    );
    prisma.exceptionCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);

    await service.recordProducerCase({
      userId: USER_ID,
      code: 'sales_platform_logistics_callback_failed',
      sourceType: 'order',
      sourceId: '99',
      sourceFingerprint: 'shipment-v1',
      subjectLabel: '销售订单 A',
      reason: '平台返回 503',
      context: { authorization: 'secret', requestId: 'safe-id' },
    });

    expect(prisma.exceptionCase.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        code: 'sales_platform_logistics_callback_failed',
        domain: 'logistics',
        sourceKind: 'producer',
        sourceActive: true,
        actionHref: '/orders',
        sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(prisma.exceptionCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'opened', caseRevision: 1 }),
    });
    const event = prisma.exceptionCaseEvent.create.mock.calls[0]![0].data;
    expect(JSON.stringify(event.evidence)).not.toContain('secret');
  });

  it('reopens an acknowledged producer case when its source fingerprint changes', async () => {
    const prisma = prismaFixture();
    prisma.exceptionCase.findUnique.mockResolvedValue(
      caseFixture({
        status: 'acknowledged',
        sourceKind: 'producer',
        sourceFingerprint: 'a'.repeat(64),
        stateRevision: 4,
        acknowledgedAt: NOW,
        acknowledgedByUserId: USER_ID,
      }),
    );
    prisma.exceptionCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.exceptionCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);

    await service.recordProducerCase({
      userId: USER_ID,
      code: 'sales_platform_logistics_callback_failed',
      sourceType: 'order',
      sourceId: '99',
      sourceFingerprint: 'changed',
      subjectLabel: '销售订单 A',
      reason: '平台仍未接受物流',
    });

    expect(prisma.exceptionCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'open',
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          occurrences: { increment: 1 },
        }),
      }),
    );
    expect(prisma.exceptionCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'reopened',
        fromStatus: 'acknowledged',
        toStatus: 'open',
        caseRevision: 5,
      }),
    });
  });

  it('only refreshes lastSeenAt when the producer fingerprint is unchanged', async () => {
    const prisma = prismaFixture();
    const sourceFingerprint = createHash('sha256')
      .update('{"producerFingerprint":"same"}')
      .digest('hex');
    prisma.exceptionCase.findUnique.mockResolvedValue(
      caseFixture({ sourceKind: 'producer', sourceFingerprint, stateRevision: 6 }),
    );
    const service = createService(prisma);

    await service.recordProducerCase({
      userId: USER_ID,
      code: 'sales_platform_logistics_callback_failed',
      sourceType: 'order',
      sourceId: '99',
      sourceFingerprint: 'same',
      subjectLabel: '销售订单 A',
      reason: '平台返回 503',
    });

    expect(prisma.exceptionCase.update).toHaveBeenCalledWith({
      where: { id: 7n },
      data: { lastSeenAt: expect.any(Date) },
    });
    expect(prisma.exceptionCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.exceptionCaseEvent.create).not.toHaveBeenCalled();
  });

  it('resolves an active producer case only inside the current tenant and records recovery evidence', async () => {
    const prisma = prismaFixture();
    prisma.exceptionCase.findUnique.mockResolvedValue(
      caseFixture({
        userId: USER_ID,
        sourceKind: 'producer',
        sourceActive: true,
        status: 'acknowledged',
        stateRevision: 6,
        acknowledgedAt: NOW,
        acknowledgedByUserId: USER_ID,
      }),
    );
    prisma.exceptionCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.exceptionCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);

    await service.resolveProducerCase({
      userId: USER_ID,
      code: 'sales_platform_logistics_status_unknown',
      sourceType: 'order',
      sourceId: '99',
      evidence: { requestId: 'request-1', platformStatus: 'shipped' },
    });

    expect(prisma.exceptionCase.findUnique).toHaveBeenCalledWith({
      where: {
        uk_exception_case_user_dedupe: {
          userId: USER_ID,
          dedupeKey: expect.stringMatching(
            /^producer:sales_platform_logistics_status_unknown:order:/,
          ),
        },
      },
    });
    expect(prisma.exceptionCase.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 7n,
        userId: USER_ID,
        sourceActive: true,
        stateRevision: 6,
        status: 'acknowledged',
      }),
      data: expect.objectContaining({
        sourceActive: false,
        status: 'resolved',
        stateRevision: { increment: 1 },
      }),
    });
    expect(prisma.exceptionCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        caseId: 7n,
        caseRevision: 7,
        type: 'resolved',
        fromStatus: 'acknowledged',
        toStatus: 'resolved',
        evidence: expect.objectContaining({
          items: expect.any(Array),
          context: expect.objectContaining({
            requestId: 'request-1',
            platformStatus: 'shipped',
          }),
        }),
      }),
    });
  });

  it('waits through the initial sync window before reporting never-synced shops', async () => {
    const prisma = prismaFixture();
    prisma.shop.findMany
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '新店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: 'encrypted-token',
          createdAt: new Date(NOW.getTime() - 60_000),
          lastOrderSyncAt: null,
          orderSyncAttemptAt: null,
          orderSyncError: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '等待首次同步店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: 'encrypted-token',
          createdAt: new Date(NOW.getTime() - 60 * 60_000),
          lastOrderSyncAt: null,
          orderSyncAttemptAt: new Date(NOW.getTime() - 5 * 60_000),
          orderSyncError: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '长时间未同步店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: 'encrypted-token',
          createdAt: new Date(NOW.getTime() - 6 * 60_000),
          lastOrderSyncAt: null,
          orderSyncAttemptAt: null,
          orderSyncError: null,
        },
      ]);
    const service = createService(prisma);
    const internals = service as unknown as {
      scanOrderSync(
        userId: bigint,
        now: Date,
      ): Promise<Array<{ code: string; dedupeKey: string; reason: string }>>;
    };

    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([]);
    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([]);
    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([
      expect.objectContaining({
        code: 'order_sync_stalled',
        dedupeKey: 'scanner:order_sync:shop:1',
        reason: expect.stringContaining('从未形成成功同步水位'),
      }),
    ]);
  });

  it('detects a hung first attempt and a successful watermark that became stale', async () => {
    const prisma = prismaFixture();
    prisma.shop.findMany
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '首次同步挂起店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: 'encrypted-token',
          createdAt: new Date(NOW.getTime() - 60 * 60_000),
          lastOrderSyncAt: null,
          orderSyncAttemptAt: new Date(NOW.getTime() - 16 * 60_000),
          orderSyncError: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '水位过期店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: 'encrypted-token',
          createdAt: new Date(NOW.getTime() - 60 * 60_000),
          lastOrderSyncAt: new Date(NOW.getTime() - 6 * 60_000),
          orderSyncAttemptAt: null,
          orderSyncError: null,
        },
      ]);
    const service = createService(prisma);
    const internals = service as unknown as {
      scanOrderSync(
        userId: bigint,
        now: Date,
      ): Promise<Array<{ code: string; dedupeKey: string; reason: string }>>;
    };

    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([
      expect.objectContaining({
        code: 'order_sync_stalled',
        dedupeKey: 'scanner:order_sync:shop:1',
        reason: expect.stringContaining('超过 15 分钟'),
      }),
    ]);
    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([
      expect.objectContaining({
        code: 'order_sync_stalled',
        dedupeKey: 'scanner:order_sync:shop:1',
        reason: expect.stringContaining('同步水位已超过'),
      }),
    ]);
  });

  it('keeps authorization and credential failures on the same shop dedupe until sync recovers', async () => {
    const prisma = prismaFixture();
    prisma.shop.findMany
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '授权失效店',
          platformShopId: 'douyin-1',
          status: 'expired',
          accessTokenEnc: null,
          createdAt: new Date(NOW.getTime() - 60 * 60_000),
          lastOrderSyncAt: new Date(NOW.getTime() - 60_000),
          orderSyncAttemptAt: null,
          orderSyncError: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '凭证缺失店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: null,
          createdAt: new Date(NOW.getTime() - 60 * 60_000),
          lastOrderSyncAt: new Date(NOW.getTime() - 60_000),
          orderSyncAttemptAt: null,
          orderSyncError: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 1n,
          shopName: '已恢复店',
          platformShopId: 'douyin-1',
          status: 'active',
          accessTokenEnc: 'encrypted-token',
          createdAt: new Date(NOW.getTime() - 60 * 60_000),
          lastOrderSyncAt: new Date(NOW.getTime() - 60_000),
          orderSyncAttemptAt: null,
          orderSyncError: null,
        },
      ]);
    const service = createService(prisma);
    const internals = service as unknown as {
      scanOrderSync(
        userId: bigint,
        now: Date,
      ): Promise<Array<{ code: string; dedupeKey: string; reason: string }>>;
    };

    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([
      expect.objectContaining({
        code: 'order_sync_authorization_invalid',
        dedupeKey: 'scanner:order_sync:shop:1',
        reason: expect.stringContaining('已过期'),
      }),
    ]);
    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([
      expect.objectContaining({
        code: 'order_sync_access_token_missing',
        dedupeKey: 'scanner:order_sync:shop:1',
        reason: expect.stringContaining('访问凭证'),
      }),
    ]);
    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([]);

    expect(prisma.shop.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        platform: 'douyin',
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      select: expect.objectContaining({
        status: true,
        accessTokenEnc: true,
      }),
    });
  });

  it('does not reopen an order-sync exception after the merchant intentionally disconnects a shop', async () => {
    const prisma = prismaFixture();
    prisma.shop.findMany.mockResolvedValue([
      {
        id: 1n,
        shopName: '已停用店铺',
        platformShopId: 'douyin-1',
        status: 'revoked',
        accessTokenEnc: null,
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        lastOrderSyncAt: new Date(NOW.getTime() - 60 * 60_000),
        orderSyncAttemptAt: null,
        orderSyncError: null,
      },
    ]);
    const service = createService(prisma);
    const internals = service as unknown as {
      scanOrderSync(userId: bigint, now: Date): Promise<unknown[]>;
    };

    await expect(internals.scanOrderSync(USER_ID, NOW)).resolves.toEqual([]);
  });

  it('keeps a failed domain untouched while other refresh domains reconcile independently', async () => {
    const prisma = prismaFixture();
    const service = createService(prisma);
    const internals = service as unknown as {
      scanPublish(): Promise<unknown[]>;
      scanOrderSync(): Promise<unknown[]>;
      scanPurchaseExceptions(): Promise<unknown[]>;
      scanAfterSaleOrders(): Promise<unknown[]>;
      scanEntitlement(): Promise<unknown[]>;
      reconcileScannerCases(): Promise<{
        scanned: number;
        created: number;
        updated: number;
        reopened: number;
        resolved: number;
      }>;
    };
    vi.spyOn(internals, 'scanPublish').mockRejectedValue(new Error('publish unavailable'));
    vi.spyOn(internals, 'scanOrderSync').mockResolvedValue([]);
    vi.spyOn(internals, 'scanPurchaseExceptions').mockResolvedValue([]);
    vi.spyOn(internals, 'scanAfterSaleOrders').mockResolvedValue([]);
    vi.spyOn(internals, 'scanEntitlement').mockResolvedValue([]);
    const reconcile = vi.spyOn(internals, 'reconcileScannerCases').mockResolvedValue({
      scanned: 0,
      created: 0,
      updated: 0,
      reopened: 0,
      resolved: 0,
    });

    const result = await service.refresh(USER_ID);

    expect(result.domains.publish).toBeUndefined();
    expect(result.errors).toEqual([
      expect.objectContaining({ domain: 'publish', code: 'DOMAIN_REFRESH_FAILED' }),
    ]);
    expect(reconcile).toHaveBeenCalledTimes(5);
  });

  it('scanner reconciliation scopes out producer cases before automatic resolution', async () => {
    const prisma = prismaFixture();
    prisma.exceptionCase.findMany.mockResolvedValue([]);
    const service = createService(prisma);
    const internals = service as unknown as {
      reconcileScannerCases(
        userId: bigint,
        scope: Prisma.ExceptionCaseWhereInput,
        observed: unknown[],
        now: Date,
      ): Promise<unknown>;
    };

    await internals.reconcileScannerCases(USER_ID, { domain: 'logistics' }, [], NOW);

    expect(prisma.exceptionCase.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: USER_ID,
        domain: 'logistics',
        sourceKind: 'scanner',
        sourceActive: true,
      }),
    });
  });

  it('automatically resolves a disappeared scanner source with evidence and one revision', async () => {
    const prisma = prismaFixture();
    prisma.exceptionCase.findMany.mockResolvedValue([
      caseFixture({ sourceKind: 'scanner', status: 'acknowledged', stateRevision: 8 }),
    ]);
    prisma.exceptionCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.exceptionCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);
    const internals = service as unknown as {
      reconcileScannerCases(
        userId: bigint,
        scope: Prisma.ExceptionCaseWhereInput,
        observed: unknown[],
        now: Date,
      ): Promise<{ resolved: number }>;
    };

    const result = await internals.reconcileScannerCases(USER_ID, { domain: 'logistics' }, [], NOW);

    expect(result.resolved).toBe(1);
    expect(prisma.exceptionCase.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 7n,
        userId: USER_ID,
        sourceActive: true,
        stateRevision: 8,
        status: 'acknowledged',
      }),
      data: expect.objectContaining({
        sourceActive: false,
        status: 'resolved',
        stateRevision: { increment: 1 },
        resolvedAt: NOW,
      }),
    });
    expect(prisma.exceptionCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caseRevision: 9,
        type: 'resolved',
        fromStatus: 'acknowledged',
        toStatus: 'resolved',
        note: expect.any(String),
        evidence: expect.any(Object),
      }),
    });
  });

  it('reads every bounded after-sale signal page before reconciling the domain', async () => {
    const exceptionSignals = vi
      .fn()
      .mockResolvedValueOnce({
        items: [afterSaleSignal('7', 'after_sale_case_overdue')],
        hasMore: true,
        nextCursor: '500',
      })
      .mockResolvedValueOnce({
        items: [afterSaleSignal('501', 'after_sale_case_blocked')],
        hasMore: false,
        nextCursor: null,
      });
    const service = createService(prismaFixture(), { exceptionSignals } as never);
    const internals = service as unknown as {
      scanAfterSaleCases(
        userId: bigint,
        now: Date,
      ): Promise<Array<{ code: string; subjectId: string; actionHref: string }>>;
    };

    const observed = await internals.scanAfterSaleCases(USER_ID, NOW);

    expect(exceptionSignals).toHaveBeenNthCalledWith(1, USER_ID, NOW, undefined);
    expect(exceptionSignals).toHaveBeenNthCalledWith(2, USER_ID, NOW, '500');
    expect(observed).toEqual([
      expect.objectContaining({
        code: 'after_sale_case_overdue',
        subjectId: '7',
        actionHref: '/after-sales',
      }),
      expect.objectContaining({
        code: 'after_sale_case_blocked',
        subjectId: '501',
        actionHref: '/after-sales',
      }),
    ]);
  });
});

function afterSaleSignal(
  caseId: string,
  code: 'after_sale_case_overdue' | 'after_sale_case_blocked',
) {
  return {
    dedupeKey: `scanner:after_sale_case:${caseId}:${code}`,
    code,
    caseId,
    priority: code === 'after_sale_case_overdue' ? ('critical' as const) : ('high' as const),
    sourceFingerprint: createHash('sha256').update(`${caseId}:${code}`).digest('hex'),
    subjectLabel: `销售订单 ${caseId}`,
    reason: code === 'after_sale_case_overdue' ? '售后工单已超过处理时限' : '采购成本待核对',
    nextAction: '打开售后工单处理',
    actionHref: '/after-sales' as const,
    overdue: code === 'after_sale_case_overdue',
  };
}

function createService(
  prisma: ReturnType<typeof prismaFixture>,
  afterSales: Pick<AfterSaleService, 'exceptionSignals'> = {
    exceptionSignals: vi.fn().mockResolvedValue({ items: [], hasMore: false, nextCursor: null }),
  },
) {
  return new ExceptionCenterService(
    prisma as unknown as PrismaService,
    { get: vi.fn().mockReturnValue('demo') } as unknown as ConfigService,
    afterSales as AfterSaleService,
  );
}

function prismaFixture() {
  const database = {
    exceptionCase: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn(),
      groupBy: vi.fn(),
    },
    exceptionCaseEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    publishTask: { findMany: vi.fn().mockResolvedValue([]) },
    publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
    shop: { findMany: vi.fn().mockResolvedValue([]) },
    purchaseOrder: { findMany: vi.fn().mockResolvedValue([]) },
    order: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  };
  database.$transaction.mockImplementation(
    async (callback: (tx: typeof database) => Promise<unknown>) => callback(database),
  );
  return database;
}

function caseFixture(overrides: Partial<ExceptionCase> = {}): ExceptionCase {
  return {
    id: 7n,
    userId: USER_ID,
    dedupeKey: 'producer:sales_platform_logistics_callback_failed:order:abc',
    domain: 'logistics',
    code: 'sales_platform_logistics_callback_failed',
    priority: 'critical',
    status: 'open',
    sourceKind: 'producer',
    sourceActive: true,
    sourceFingerprint: createHash('sha256').update('fixture').digest('hex'),
    subjectType: 'order',
    subjectId: '99',
    subjectLabel: '销售订单 A',
    responsibleParty: 'merchant',
    reason: '平台返回 503',
    impact: '物流未回传',
    nextAction: '重新核验',
    actionLabel: '处理物流回传',
    actionHref: '/orders',
    occurrences: 1,
    stateRevision: 1,
    lastSeenAt: NOW,
    acknowledgedAt: null,
    acknowledgedByUserId: null,
    resolvedAt: null,
    resolutionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function eventFixture(overrides: Partial<ExceptionCaseEvent> = {}): ExceptionCaseEvent {
  return {
    id: 1n,
    userId: USER_ID,
    caseId: 7n,
    caseRevision: 1,
    type: 'opened',
    clientRequestId: null,
    actorUserId: null,
    note: null,
    evidence: null,
    fromStatus: null,
    toStatus: 'open',
    sourceFingerprint: createHash('sha256').update('fixture').digest('hex'),
    createdAt: NOW,
    ...overrides,
  };
}
