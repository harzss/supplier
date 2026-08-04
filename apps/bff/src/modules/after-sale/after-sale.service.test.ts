import { ConfigService } from '@nestjs/config';
import type { AfterSaleCase, AfterSaleCaseEvent, AfterSalePurchaseLink } from '@supplier/db';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { AfterSaleService } from './after-sale.service';

const USER_ID = 42n;
const OTHER_USER_ID = 84n;
const NOW = new Date('2026-08-05T08:00:00.000Z');
const CLIENT_REQUEST_ID = '8e07fc63-cd13-41f2-a2de-cc7ca0fa6312';

describe('AfterSaleService', () => {
  it('lists only the tenant and returns status plus overdue counts', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCase.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    prisma.afterSaleCase.groupBy.mockResolvedValue([
      { status: 'open', _count: { _all: 1 } },
      { status: 'closed', _count: { _all: 2 } },
    ]);
    prisma.afterSaleCase.findMany.mockResolvedValue([detailFixture()]);
    const service = createService(prisma);

    const result = await service.list(USER_ID, {
      status: 'open',
      overdue: true,
      page: 1,
      pageSize: 30,
    });

    expect(prisma.afterSaleCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          AND: expect.arrayContaining([
            { status: 'open' },
            {
              status: { not: 'closed' },
              nextActionDueAt: { lt: expect.any(Date) },
            },
          ]),
        }),
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      overdueCount: 2,
      counts: { open: 1, handling: 0, waitingExternal: 0, verifying: 0, closed: 2 },
    });
  });

  it('excludes historical demo-shop cases from every production read scope', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCase.count.mockResolvedValue(0);
    prisma.afterSaleCase.groupBy.mockResolvedValue([]);
    prisma.afterSaleCase.findMany.mockResolvedValue([]);
    prisma.afterSaleCase.findFirst.mockResolvedValue(detailFixture());
    const service = createService(prisma, 'supabase');

    await service.list(USER_ID, { page: 1, pageSize: 30 });
    await service.detail(USER_ID, '7', NOW);
    await service.exceptionSignals(USER_ID, NOW);

    const productionScope = {
      userId: USER_ID,
      order: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
    };
    expect(prisma.afterSaleCase.findMany.mock.calls[0]![0].where).toEqual(productionScope);
    expect(prisma.afterSaleCase.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: productionScope }),
    );
    expect(prisma.afterSaleCase.count.mock.calls).toEqual(
      expect.arrayContaining([
        [expect.objectContaining({ where: productionScope })],
        [
          expect.objectContaining({
            where: expect.objectContaining(productionScope),
          }),
        ],
      ]),
    );
    expect(prisma.afterSaleCase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7n, ...productionScope } }),
    );
    expect(prisma.afterSaleCase.findMany.mock.calls[1]![0].where).toEqual({
      ...productionScope,
      status: { not: 'closed' },
    });
  });

  it('claims with tenant and revision CAS and appends one command event', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSaleCase.findFirst.mockResolvedValue(caseFixture({ stateRevision: 3 }));
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma, 'supabase');
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7', status: 'handling' } as never);

    await service.claim(USER_ID, '7', {
      expectedRevision: 3,
      clientRequestId: CLIENT_REQUEST_ID,
      note: '  已开始处理售后  ',
    });

    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7n,
        userId: USER_ID,
        order: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
        stateRevision: 3,
        status: { not: 'closed' },
      },
      data: expect.objectContaining({
        status: 'handling',
        waitingOn: 'merchant',
        assigneeUserId: USER_ID,
        stateRevision: { increment: 1 },
      }),
    });
    expect(prisma.afterSaleCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        caseId: 7n,
        caseRevision: 4,
        type: 'claimed',
        clientRequestId: CLIENT_REQUEST_ID,
        actorUserId: USER_ID,
        note: '已开始处理售后',
      }),
    });
  });

  it('replays the same command and rejects a reused UUID with different parameters', async () => {
    const prisma = prismaFixture();
    const service = createService(prisma);
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7', status: 'handling' } as never);
    const matchingFingerprint = commandFingerprint({
      command: 'claim',
      caseId: '7',
      expectedRevision: 3,
      note: '已开始处理售后',
    });
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(
      eventFixture({
        type: 'claimed',
        clientRequestId: CLIENT_REQUEST_ID,
        requestFingerprint: matchingFingerprint,
      }),
    );
    prisma.afterSaleCase.findFirst.mockResolvedValue({ id: 7n });

    await expect(
      service.claim(USER_ID, '7', {
        expectedRevision: 3,
        clientRequestId: CLIENT_REQUEST_ID,
        note: '已开始处理售后',
      }),
    ).resolves.toMatchObject({ id: '7' });
    expect(prisma.afterSaleCase.updateMany).not.toHaveBeenCalled();

    await expect(
      service.claim(USER_ID, '7', {
        expectedRevision: 3,
        clientRequestId: CLIENT_REQUEST_ID,
        note: '不同参数',
      }),
    ).rejects.toThrow('请求标识已被其他参数使用');
  });

  it('does not replay a historical demo-shop command in production', async () => {
    const prisma = prismaFixture();
    const note = '已核对全部退款与采购结果';
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(
      eventFixture({
        type: 'closed',
        clientRequestId: CLIENT_REQUEST_ID,
        requestFingerprint: commandFingerprint({
          command: 'verify_close',
          caseId: '7',
          expectedRevision: 1,
          resolutionCode: 'full_refund_handled',
          note,
        }),
      }),
    );
    prisma.afterSaleCase.findFirst.mockResolvedValue(null);
    const service = createService(prisma, 'supabase');

    await expect(
      service.verifyClose(
        USER_ID,
        '7',
        {
          expectedRevision: 1,
          clientRequestId: CLIENT_REQUEST_ID,
          resolutionCode: 'full_refund_handled',
          note,
        },
        NOW,
      ),
    ).rejects.toThrow('售后工单不存在');
    expect(prisma.afterSaleCase.findFirst).toHaveBeenCalledWith({
      where: {
        id: 7n,
        userId: USER_ID,
        order: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
      },
      select: { id: true },
    });
    expect(prisma.afterSaleCase.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a stale case revision before any command side effect', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSaleCase.findFirst.mockResolvedValue(caseFixture({ stateRevision: 4 }));
    const service = createService(prisma);

    await expect(
      service.claim(USER_ID, '7', {
        expectedRevision: 3,
        clientRequestId: CLIENT_REQUEST_ID,
        note: '使用旧页面认领',
      }),
    ).rejects.toThrow('售后工单已更新');
    expect(prisma.afterSaleCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.afterSaleCaseEvent.create).not.toHaveBeenCalled();
  });

  it('does not expose or mutate another tenant case', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSaleCase.findFirst.mockResolvedValue(null);
    const service = createService(prisma);

    await expect(
      service.claim(OTHER_USER_ID, '7', {
        expectedRevision: 1,
        clientRequestId: CLIENT_REQUEST_ID,
        note: '尝试跨租户处理',
      }),
    ).rejects.toThrow('售后工单不存在');
    expect(prisma.afterSaleCase.updateMany).not.toHaveBeenCalled();
  });

  it('starts a manual purchase action only against current case and purchase revisions', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSalePurchaseLink.findFirst.mockResolvedValue(
      linkFixture({
        case: caseFixture({ stateRevision: 2 }),
        purchaseOrder: purchaseFixture(),
      }),
    );
    prisma.afterSalePurchaseLink.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma, 'supabase');
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7' } as never);

    await service.startPurchaseAction(USER_ID, '7', '11', {
      expectedRevision: 2,
      expectedPurchaseExceptionRevision: 4,
      expectedPurchaseSyncRevision: 6,
      clientRequestId: CLIENT_REQUEST_ID,
      action: 'refund',
      remoteReferenceType: 'refund',
      remoteReferenceId: 'RF-001',
      note: '已在 1688 后台提交退款',
    });

    expect(prisma.afterSalePurchaseLink.updateMany).toHaveBeenCalledWith({
      where: {
        id: 11n,
        caseId: 7n,
        userId: USER_ID,
        case: {
          userId: USER_ID,
          order: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
        },
        status: { in: ['action_required', 'failed'] },
        purchaseFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        boundSourceRevision: 1,
        expectedPurchaseExceptionRevision: 4,
        expectedPurchaseSyncRevision: 6,
      },
      data: expect.objectContaining({
        status: 'waiting_external',
        action: 'refund',
        remoteReferenceType: 'refund',
        remoteReferenceId: 'RF-001',
      }),
    });
    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 7n,
          userId: USER_ID,
          order: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
        }),
      }),
    );
  });

  it('rejects confirming an action after the purchase revisions changed', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSalePurchaseLink.findFirst.mockResolvedValue(
      linkFixture({
        status: 'waiting_external',
        action: 'refund',
        case: caseFixture({ stateRevision: 3 }),
        purchaseOrder: purchaseFixture({ exceptionRevision: 5 }),
      }),
    );
    const service = createService(prisma);

    await expect(
      service.confirmPurchaseAction(USER_ID, '7', '11', {
        expectedRevision: 3,
        expectedPurchaseExceptionRevision: 4,
        expectedPurchaseSyncRevision: 6,
        clientRequestId: CLIENT_REQUEST_ID,
        result: 'confirmed',
        remoteReferenceType: 'refund',
        remoteReferenceId: 'RF-001',
        note: '供应商已退款',
        evidence: { screenshotObjectKey: 'private/evidence/1.png' },
      }),
    ).rejects.toThrow('采购状态已变化');
    expect(prisma.afterSalePurchaseLink.updateMany).not.toHaveBeenCalled();
  });

  it('keeps the production shop scope on purchase confirmation writes', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSalePurchaseLink.findFirst.mockResolvedValue(
      linkFixture({
        status: 'waiting_external',
        action: 'refund',
        remoteReferenceType: 'refund',
        remoteReferenceId: 'RF-001',
        startedAt: NOW,
        case: caseFixture({ stateRevision: 3 }),
      }),
    );
    prisma.afterSalePurchaseLink.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma, 'supabase');
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7' } as never);

    await service.confirmPurchaseAction(USER_ID, '7', '11', {
      expectedRevision: 3,
      expectedPurchaseExceptionRevision: 4,
      expectedPurchaseSyncRevision: 6,
      clientRequestId: CLIENT_REQUEST_ID,
      result: 'confirmed',
      note: '供应商已退款',
    });

    const caseScope = {
      userId: USER_ID,
      order: { shop: { NOT: { platformShopId: { startsWith: 'demo-' } } } },
    };
    expect(prisma.afterSalePurchaseLink.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID, case: caseScope }),
      }),
    );
    expect(prisma.afterSalePurchaseLink.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID, case: caseScope }),
      }),
    );
    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(caseScope) }),
    );
  });

  it('reopens a closed case when the authoritative source fingerprint changes', async () => {
    const prisma = prismaFixture();
    prisma.order.findUnique.mockResolvedValue(orderGraphFixture());
    prisma.afterSaleCase.findUnique.mockResolvedValue(
      caseFixture({
        status: 'closed',
        sourceActive: false,
        sourceFingerprint: 'a'.repeat(64),
        sourceRevision: 2,
        stateRevision: 5,
        closedAt: NOW,
        resolutionCode: 'full_refund_handled',
        resolutionNote: '旧售后已完成',
        closedByUserId: USER_ID,
      }),
    );
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    prisma.afterSaleCaseItem.findMany.mockResolvedValue([]);
    prisma.afterSalePurchaseLink.findMany.mockResolvedValue([]);
    const service = createService(prisma);

    const result = await service.materializeOrder(prisma as never, 99n, NOW);

    expect(result).toMatchObject({ change: 'reopened' });
    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'open',
          sourceActive: true,
          sourceRevision: { increment: 1 },
          stateRevision: { increment: 1 },
          occurrences: { increment: 1 },
          resolutionCode: null,
          closedAt: null,
        }),
      }),
    );
    expect(prisma.afterSaleCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'reopened', fromStatus: 'closed', toStatus: 'open' }),
    });
  });

  it('returns explicit closure blockers and never closes on stale sales evidence', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSaleCase.findFirst.mockResolvedValue(
      detailFixture({
        order: orderGraphFixture({
          afterSaleSyncedAt: new Date(NOW.getTime() - 10 * 60_000),
        }),
      }),
    );
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);

    await expect(
      service.verifyClose(
        USER_ID,
        '7',
        {
          expectedRevision: 1,
          clientRequestId: CLIENT_REQUEST_ID,
          resolutionCode: 'full_refund_handled',
          note: '已核对全部退款与采购结果',
        },
        NOW,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'AFTER_SALE_NOT_CLOSABLE',
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'SALES_SOURCE_STALE' })]),
      }),
    });
    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { stateRevision: { increment: 1 } },
      }),
    );
  });

  it('keeps purchase order identity on blockers for multi-purchase cases', async () => {
    const prisma = prismaFixture();
    const secondPurchase = purchaseFixture({ id: 22n, orderId1688: '1688-2' });
    prisma.afterSaleCase.findFirst.mockResolvedValue(
      detailFixture({
        order: orderGraphFixture({
          purchaseOrders: [purchaseFixture(), secondPurchase],
        }),
        links: [
          linkFixture(),
          linkFixture({
            id: 12n,
            purchaseOrderId: 22n,
            purchaseOrder: secondPurchase,
          }),
        ],
      }),
    );
    const service = createService(prisma);

    const result = await service.detail(USER_ID, '7', NOW);

    expect(
      result.closureBlockers
        .filter((blocker) => blocker.code === 'PURCHASE_COST_RECONCILIATION_REQUIRED')
        .map((blocker) => blocker.purchaseOrderId),
    ).toEqual(['21', '22']);
  });

  it('keeps status, overdue and search filters as independent AND clauses', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCase.count.mockResolvedValue(0);
    prisma.afterSaleCase.groupBy.mockResolvedValue([]);
    prisma.afterSaleCase.findMany.mockResolvedValue([]);
    const service = createService(prisma);

    await service.list(USER_ID, {
      status: 'handling',
      overdue: false,
      q: 'DOUYIN-99',
      page: 1,
      pageSize: 30,
    });

    expect(prisma.afterSaleCase.findMany.mock.calls[0]![0].where).toEqual({
      userId: USER_ID,
      AND: [
        { status: 'handling' },
        { OR: [{ status: 'closed' }, { nextActionDueAt: { gte: expect.any(Date) } }] },
        {
          OR: [
            {
              order: {
                platformOrderId: { contains: 'DOUYIN-99', mode: 'insensitive' },
              },
            },
            {
              order: {
                shop: { shopName: { contains: 'DOUYIN-99', mode: 'insensitive' } },
              },
            },
            {
              links: {
                some: { purchaseOrder: { orderId1688: { contains: 'DOUYIN-99' } } },
              },
            },
          ],
        },
      ],
    });
  });

  it('exposes a cursor so orders after the first 500 are reachable', async () => {
    const prisma = prismaFixture();
    prisma.order.findMany
      .mockResolvedValueOnce(Array.from({ length: 501 }, (_, index) => ({ id: BigInt(index + 1) })))
      .mockResolvedValueOnce([{ id: 501n }]);
    const service = createService(prisma);
    vi.spyOn(service, 'materializeOrder').mockImplementation(async (_tx, orderId) => ({
      orderId: orderId.toString(),
      caseId: orderId.toString(),
      change: 'unchanged',
    }));

    const first = await service.refreshUser(USER_ID, NOW);
    const second = await service.refreshUser(USER_ID, NOW, first.nextCursor ?? undefined);

    expect(first).toMatchObject({ scanned: 500, hasMore: true, nextCursor: '500' });
    expect(second).toMatchObject({ scanned: 1, hasMore: false, nextCursor: null });
    expect(prisma.order.findMany.mock.calls[1]![0].where).toEqual(
      expect.objectContaining({ id: { gt: 500n } }),
    );
  });

  it('paginates exception signals without silently dropping cases after the first batch', async () => {
    const prisma = prismaFixture();
    prisma.afterSaleCase.findMany
      .mockResolvedValueOnce(
        Array.from({ length: 501 }, (_, index) =>
          detailFixture({ id: BigInt(index + 1), orderId: BigInt(index + 1000) }),
        ),
      )
      .mockResolvedValueOnce([detailFixture({ id: 501n, orderId: 1500n })]);
    const service = createService(prisma);

    const first = await service.exceptionSignals(USER_ID, NOW);
    const second = await service.exceptionSignals(USER_ID, NOW, first.nextCursor ?? undefined);

    expect(first).toMatchObject({ hasMore: true, nextCursor: '500' });
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
    expect(prisma.afterSaleCase.findMany.mock.calls[1]![0].where).toEqual(
      expect.objectContaining({ id: { gt: 500n } }),
    );
  });

  it('reopens a closed case and invalidates confirmation when purchase facts change', async () => {
    const prisma = prismaFixture();
    const order = orderGraphFixture();
    const sourceFingerprint = sourceFingerprintFixture(order);
    const current = caseFixture({
      status: 'closed',
      waitingOn: 'none',
      sourceActive: false,
      assigneeUserId: USER_ID,
      sourceFingerprint,
      stateRevision: 5,
      resolutionCode: 'full_refund_handled',
      resolutionNote: '旧采购事实已核验',
      closedAt: NOW,
      closedByUserId: USER_ID,
    });
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.afterSaleCase.findUnique.mockResolvedValue(current);
    prisma.afterSaleCaseItem.findMany.mockResolvedValue([
      {
        id: 1n,
        userId: USER_ID,
        caseId: 7n,
        orderId: 99n,
        orderItemId: 31n,
        sourceRevision: 1,
        active: true,
        platformAfterSaleId: null,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      },
    ]);
    prisma.afterSalePurchaseLink.findMany.mockResolvedValue([
      linkFixture({
        status: 'confirmed',
        action: 'refund',
        result: 'confirmed',
        purchaseFingerprint: 'a'.repeat(64),
        expectedPurchaseExceptionRevision: 3,
        startedAt: NOW,
        confirmedAt: NOW,
        confirmedByUserId: USER_ID,
      }),
    ]);
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);

    await expect(service.materializeOrder(prisma as never, 99n, NOW)).resolves.toMatchObject({
      change: 'reopened',
    });

    expect(prisma.afterSalePurchaseLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'action_required',
          action: 'none',
          expectedPurchaseExceptionRevision: 4,
        }),
      }),
    );
    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ stateRevision: 5 }),
        data: expect.objectContaining({ stateRevision: { increment: 1 } }),
      }),
    );
    expect(prisma.afterSaleCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'reopened',
        caseRevision: 6,
        evidence: expect.objectContaining({ purchaseVersions: expect.any(Array) }),
      }),
    });
  });

  it('advances the purchase CAS revision without reopening a healthy closed case', async () => {
    const prisma = prismaFixture();
    const order = orderGraphFixture({
      purchaseOrders: [purchaseFixture({ syncRevision: 7 })],
    });
    const current = caseFixture({
      status: 'closed',
      waitingOn: 'none',
      sourceActive: false,
      assigneeUserId: USER_ID,
      sourceFingerprint: sourceFingerprintFixture(order),
      stateRevision: 5,
      resolutionCode: 'full_refund_handled',
      resolutionNote: '采购事实已核验',
      closedAt: NOW,
      closedByUserId: USER_ID,
    });
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.afterSaleCase.findUnique.mockResolvedValue(current);
    prisma.afterSaleCaseItem.findMany.mockResolvedValue([
      { id: 1n, caseId: 7n, orderItemId: 31n, sourceRevision: 1, active: true },
    ]);
    prisma.afterSalePurchaseLink.findMany.mockResolvedValue([
      linkFixture({
        status: 'confirmed',
        action: 'refund',
        result: 'confirmed',
        expectedPurchaseSyncRevision: 6,
        startedAt: NOW,
        confirmedAt: NOW,
        confirmedByUserId: USER_ID,
      }),
    ]);
    const service = createService(prisma);

    await expect(service.materializeOrder(prisma as never, 99n, NOW)).resolves.toMatchObject({
      change: 'unchanged',
    });

    expect(prisma.afterSalePurchaseLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'confirmed',
          expectedPurchaseSyncRevision: 7,
        }),
      }),
    );
    expect(prisma.afterSaleCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.afterSaleCaseEvent.create).not.toHaveBeenCalled();
  });

  it('keeps a closed case inactive when the same source is observed again', async () => {
    const prisma = prismaFixture();
    const order = orderGraphFixture({ purchaseOrders: [] });
    const current = caseFixture({
      status: 'closed',
      waitingOn: 'none',
      sourceActive: false,
      sourceFingerprint: sourceFingerprintFixture(order),
      resolutionCode: 'sales_rejected_or_withdrawn',
      resolutionNote: '已关闭',
      closedAt: NOW,
      closedByUserId: USER_ID,
    });
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.afterSaleCase.findUnique.mockResolvedValue(current);
    prisma.afterSaleCaseItem.findMany.mockResolvedValue([
      {
        id: 1n,
        caseId: 7n,
        orderItemId: 31n,
        sourceRevision: 1,
        active: true,
      },
    ]);
    prisma.afterSalePurchaseLink.findMany.mockResolvedValue([]);
    const service = createService(prisma);

    await service.materializeOrder(prisma as never, 99n, NOW);

    expect(prisma.afterSaleCase.update).toHaveBeenCalledWith({
      where: { id: 7n },
      data: expect.objectContaining({ sourceActive: false }),
    });
    expect(prisma.afterSaleCase.updateMany).not.toHaveBeenCalled();
    expect(prisma.afterSaleCaseEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a half-specified remote reference before writing confirmation', async () => {
    const prisma = prismaFixture();
    const service = createService(prisma);

    await expect(
      service.confirmPurchaseAction(USER_ID, '7', '11', {
        expectedRevision: 3,
        expectedPurchaseExceptionRevision: 4,
        expectedPurchaseSyncRevision: 6,
        clientRequestId: CLIENT_REQUEST_ID,
        result: 'confirmed',
        remoteReferenceType: 'refund',
        note: '供应商已退款',
      }),
    ).rejects.toThrow('外部处理类型与编号必须同时提供');
    expect(prisma.afterSaleCaseEvent.findUnique).not.toHaveBeenCalled();
  });

  it('closes only after current sales and purchase facts have no blockers', async () => {
    const prisma = prismaFixture();
    const order = orderGraphFixture({
      afterSaleStatus: 'failed',
      items: [
        {
          id: 31n,
          orderId: 99n,
          platformOrderItemId: 'ITEM-1',
          title: '测试商品',
          quantity: 1,
          afterSaleStatusRaw: 27,
          afterSaleTypeRaw: 1,
          refundStatusRaw: 4,
        },
      ],
      purchaseOrders: [],
    });
    const current = detailFixture({
      sourceActive: false,
      sourceFingerprint: sourceFingerprintFixture(order),
      order,
      links: [],
    });
    prisma.afterSaleCaseEvent.findUnique.mockResolvedValue(null);
    prisma.afterSaleCase.findFirst.mockResolvedValue(current);
    prisma.afterSaleCase.updateMany.mockResolvedValue({ count: 1 });
    prisma.afterSaleCaseEvent.create.mockResolvedValue(eventFixture());
    const service = createService(prisma);
    vi.spyOn(service, 'detail').mockResolvedValue({ id: '7', status: 'closed' } as never);

    await expect(
      service.verifyClose(
        USER_ID,
        '7',
        {
          expectedRevision: 1,
          clientRequestId: CLIENT_REQUEST_ID,
          resolutionCode: 'sales_rejected_or_withdrawn',
          note: '平台售后已拒绝，采购无需处理',
        },
        NOW,
      ),
    ).resolves.toMatchObject({ status: 'closed' });

    expect(prisma.afterSaleCase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'closed',
          waitingOn: 'none',
          sourceActive: false,
          resolutionCode: 'sales_rejected_or_withdrawn',
        }),
      }),
    );
    expect(prisma.afterSaleCaseEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'closed', toStatus: 'closed' }),
    });
  });
});

function createService(
  prisma: ReturnType<typeof prismaFixture>,
  authMode: 'demo' | 'supabase' = 'demo',
) {
  return new AfterSaleService(
    prisma as unknown as PrismaService,
    { get: vi.fn().mockReturnValue(authMode) } as unknown as ConfigService,
  );
}

function prismaFixture() {
  const database = {
    afterSaleCase: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    afterSaleCaseItem: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    afterSalePurchaseLink: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    afterSaleCaseEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    order: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  database.$transaction.mockImplementation(
    async (callback: (tx: typeof database) => Promise<unknown>) => callback(database),
  );
  return database;
}

function caseFixture(overrides: Partial<AfterSaleCase> = {}): AfterSaleCase {
  return {
    id: 7n,
    userId: USER_ID,
    orderId: 99n,
    status: 'open',
    waitingOn: 'merchant',
    priority: 'high',
    sourceActive: true,
    sourceFingerprint: createHash('sha256').update('fixture').digest('hex'),
    sourceRevision: 1,
    stateRevision: 1,
    occurrences: 1,
    assigneeUserId: null,
    firstDetectedAt: NOW,
    lastObservedAt: NOW,
    nextActionDueAt: new Date(NOW.getTime() + 2 * 60 * 60_000),
    platformDeadlineAt: null,
    resolutionCode: null,
    resolutionNote: null,
    closedAt: null,
    closedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function linkFixture(
  overrides: Partial<AfterSalePurchaseLink> & { case?: unknown; purchaseOrder?: unknown } = {},
) {
  return {
    id: 11n,
    userId: USER_ID,
    caseId: 7n,
    orderId: 99n,
    purchaseOrderId: 21n,
    status: 'action_required',
    action: 'none',
    result: null,
    remoteReferenceType: null,
    remoteReferenceId: null,
    purchaseFingerprint: purchaseFingerprintFixture(),
    boundSourceRevision: 1,
    expectedPurchaseExceptionRevision: 4,
    expectedPurchaseSyncRevision: 6,
    startedAt: null,
    confirmedAt: null,
    confirmedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    case: caseFixture(),
    purchaseOrder: purchaseFixture(),
    ...overrides,
  };
}

function purchaseFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 21n,
    orderId: 99n,
    orderId1688: '1688-1',
    status: 'awaiting_payment',
    exceptionStatus: 'action_required',
    exceptionCode: null,
    exceptionRevision: 4,
    syncRevision: 6,
    reconciledCost: null,
    everShipped: false,
    items: [],
    ...overrides,
  };
}

function purchaseFingerprintFixture(): string {
  return commandFingerprint({
    orderId1688: '1688-1',
    status: 'awaiting_payment',
    exceptionStatus: 'action_required',
    exceptionCode: null,
    exceptionRevision: 4,
    reconciledCost: null,
    everShipped: false,
  });
}

function orderGraphFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 99n,
    shopId: 3n,
    platformOrderId: 'DOUYIN-99',
    amount: 100,
    status: 'paid',
    afterSaleStatus: 'pending',
    afterSaleSyncedAt: NOW,
    partialRefundDisposition: 'none',
    partialRefundFingerprint: 'b'.repeat(64),
    refundAmount: null,
    refundAmountFingerprint: null,
    shop: { id: 3n, userId: USER_ID, platform: 'douyin', platformShopId: 'douyin-3' },
    items: [
      {
        id: 31n,
        orderId: 99n,
        platformOrderItemId: 'ITEM-1',
        title: '测试商品',
        afterSaleStatusRaw: 6,
        afterSaleTypeRaw: 1,
        refundStatusRaw: 1,
      },
    ],
    purchaseOrders: [purchaseFixture()],
    ...overrides,
  };
}

function detailFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...caseFixture(),
    order: orderGraphFixture(),
    items: [],
    links: [],
    events: [],
    ...overrides,
  };
}

function eventFixture(overrides: Partial<AfterSaleCaseEvent> = {}): AfterSaleCaseEvent {
  return {
    id: 1n,
    userId: USER_ID,
    caseId: 7n,
    caseRevision: 1,
    type: 'opened',
    clientRequestId: null,
    requestFingerprint: null,
    actorUserId: null,
    note: null,
    evidence: null,
    fromStatus: null,
    toStatus: 'open',
    sourceRevision: 1,
    sourceFingerprint: createHash('sha256').update('fixture').digest('hex'),
    createdAt: NOW,
    ...overrides,
  };
}

function commandFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sourceFingerprintFixture(order: ReturnType<typeof orderGraphFixture>): string {
  return commandFingerprint({
    amount: Number(order.amount).toFixed(2),
    terminalOrderStatus: ['refunded', 'closed'].includes(String(order.status))
      ? order.status
      : null,
    afterSaleStatus: order.afterSaleStatus,
    items: [...order.items]
      .map((item) => ({
        platformOrderItemId: item.platformOrderItemId,
        afterSaleStatus: item.afterSaleStatusRaw,
        afterSaleType: item.afterSaleTypeRaw,
        refundStatus: item.refundStatusRaw,
      }))
      .sort((left, right) => left.platformOrderItemId.localeCompare(right.platformOrderItemId)),
  });
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}
