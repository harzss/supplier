import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import { FINANCIAL_RECONCILIATION_ORDER_WHERE } from './financial-reconciliation';
import { maskReceiverName, OrderService, maskPhone, type OrderView } from './order.service';

const USER: CurrentUser = { userId: 1n, plan: 'pro' };

function authConfig(authMode: 'demo' | 'supabase' = 'demo'): ConfigService {
  return { get: (key: string) => (key === 'AUTH_MODE' ? authMode : undefined) } as ConfigService;
}

function makeService() {
  const shop = { id: 5n, userId: 1n, platform: 'douyin', shopName: '我的抖音店' };
  const pp = { id: 10n, shopId: 5n, salePrice: 28.35, shop };
  const captured: { createData?: Record<string, unknown> } = {};
  const findPublishedProduct = vi.fn().mockResolvedValue(pp);
  const prisma = {
    publishedProduct: { findFirst: findPublishedProduct },
    order: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        captured.createData = data;
        return {
          id: 100n,
          ...data,
          afterSaleStatus: 'none',
          afterSaleSyncedAt: null,
          partialRefundDisposition: 'none',
          partialRefundDispositionAt: null,
          partialRefundDispositionNote: null,
          shop,
          publishedProduct: { title: '纯棉T恤' },
          items: [],
          purchaseOrders: [],
        };
      },
      findMany: async () => [],
    },
  } as unknown as PrismaService;
  const crypto = new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService);
  return {
    svc: new OrderService(prisma, crypto, authConfig()),
    captured,
    findPublishedProduct,
  };
}

describe('maskPhone', () => {
  it('masks the middle digits', () => {
    expect(maskPhone('13811112222')).toBe('138****2222');
    expect(maskPhone('123')).toBe('****');
  });
});

describe('maskReceiverName', () => {
  it('keeps only the first character', () => {
    expect(maskReceiverName('张三')).toBe('张*');
    expect(maskReceiverName('欧阳娜娜')).toBe('欧**');
  });
});

describe('OrderService.simulate', () => {
  it('creates a paid order with encrypted buyer info and masked view', async () => {
    const { svc, captured, findPublishedProduct } = makeService();
    const view = await svc.simulate(USER, '10');
    expect(findPublishedProduct).toHaveBeenCalledWith({
      where: {
        id: 10n,
        status: 'online',
        shop: {
          userId: 1n,
          role: 'seller',
          status: 'active',
          platformShopId: { startsWith: 'demo-' },
        },
      },
      include: { shop: true },
    });
    expect(view.status).toBe('paid');
    expect(view.amount).toBe(28.35);
    expect(view.receiverPhoneMasked).toMatch(/\*\*\*\*/);
    // 存储的是密文，不含明文手机号
    expect(String(captured.createData?.receiverPhoneEnc)).not.toMatch(/1\d{10}/);
    expect(captured.createData?.receiverAddressEnc).toBeDefined();
    expect(captured.createData?.receiverName).not.toBe('李萌');
    expect(captured.createData?.receiverNameEnc).toBeDefined();
  });

  it('rejects simulation before database access outside demo auth mode', async () => {
    const findFirst = vi.fn();
    const prisma = { publishedProduct: { findFirst } } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig('supabase'),
    );

    await expect(service.simulate(USER, '10')).rejects.toThrow('当前环境不支持模拟买家下单');
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('OrderService.list', () => {
  it('pages tenant orders and applies seller shop and status filters', async () => {
    const count = vi.fn().mockResolvedValue(31);
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { order: { count, findMany } } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig('supabase'),
    );

    await expect(service.list(USER, 2, 30, '9', 'shipped')).resolves.toEqual({
      items: [],
      total: 31,
      page: 2,
      pageSize: 30,
    });

    const where = {
      shop: {
        userId: 1n,
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
        id: 9n,
      },
      status: 'shipped',
    };
    expect(count).toHaveBeenCalledWith({ where });
    expect(findMany).toHaveBeenCalledWith({
      where,
      orderBy: { id: 'desc' },
      skip: 30,
      take: 30,
      include: {
        shop: true,
        publishedProduct: true,
        items: true,
        purchaseOrders: { include: { shipments: true } },
      },
    });
  });
});

describe('OrderService.listFinancialReconciliations', () => {
  it('counts and pages all financial work for the current tenant', async () => {
    const count = vi.fn().mockResolvedValue(42);
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { order: { count, findMany } } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig('supabase'),
    );

    await expect(service.listFinancialReconciliations(USER, 2, 30)).resolves.toEqual({
      items: [],
      total: 42,
      page: 2,
      pageSize: 30,
    });

    const where = {
      ...FINANCIAL_RECONCILIATION_ORDER_WHERE,
      shop: {
        userId: 1n,
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
    };
    expect(count).toHaveBeenCalledWith({ where });
    expect(findMany).toHaveBeenCalledWith({
      where,
      orderBy: { id: 'desc' },
      skip: 30,
      take: 30,
      include: {
        shop: true,
        publishedProduct: true,
        items: true,
        purchaseOrders: { include: { shipments: true } },
      },
    });
  });
});

describe('OrderService.getOne', () => {
  it('does not flag a normal in-progress 1688 purchase as a refund exception', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          platformOrderId: 'order-5',
          buyerNick: null,
          receiverName: null,
          receiverPhoneEnc: null,
          amount: 10,
          status: 'purchasing',
          afterSaleStatus: 'none',
          afterSaleSyncedAt: new Date(),
          partialRefundDisposition: 'none',
          partialRefundDispositionAt: null,
          partialRefundDispositionNote: null,
          paidAt: new Date(),
          shop: { shopName: '测试店铺', platform: 'douyin' },
          publishedProduct: { title: '测试商品' },
          items: [],
          purchaseOrders: [
            {
              id: 7n,
              outOrderId: 'supplier-5-a',
              orderId1688: '900001',
              paymentMode: 'manual',
              status: 'awaiting_payment',
              trackingNo: null,
              carrier: null,
              exceptionStatus: 'none',
              exceptionReason: null,
              exceptionDetectedAt: null,
              exceptionResolvedAt: null,
              exceptionResolutionNote: null,
              shipments: [],
            },
          ],
        }),
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    const result = await service.getOne(USER, '5');

    expect(result.fulfillmentExceptionStatus).toBe('none');
    expect(result.fulfillmentExceptionMessage).toBeNull();
  });

  it('routes a settled shipment anomaly to the dedicated logistics repair action', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          platformOrderId: 'order-5',
          buyerNick: null,
          receiverName: null,
          receiverPhoneEnc: null,
          amount: 10,
          status: 'shipped',
          afterSaleStatus: 'none',
          afterSaleSyncedAt: new Date(),
          partialRefundDisposition: 'none',
          partialRefundDispositionAt: null,
          partialRefundDispositionNote: null,
          paidAt: new Date(),
          shop: { shopName: '测试店铺', platform: 'douyin' },
          publishedProduct: { title: '测试商品' },
          items: [],
          purchaseOrders: [
            {
              id: 7n,
              outOrderId: 'supplier-5-a',
              orderId1688: '900001',
              paymentMode: 'manual',
              purchaseCost: 12,
              priorIncurredCost: 0,
              reconciledCost: null,
              status: 'shipped',
              attemptNo: 1,
              retryEligible: false,
              everShipped: true,
              trackingNo: 'OLD111',
              carrier: '顺丰速运',
              exceptionStatus: 'action_required',
              exceptionRevision: 4,
              exceptionReason: '1688 物流发生变化',
              exceptionDetectedAt: new Date(),
              exceptionResolvedAt: null,
              exceptionResolutionNote: null,
              shipments: [{ trackingNo: 'OLD111', carrier: '顺丰速运', status: 'ACCEPT' }],
            },
          ],
        }),
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    const result = await service.getOne(USER, '5');

    expect(result.fulfillmentExceptionStatus).toBe('action_required');
    expect(result.purchases[0]).toMatchObject({
      logisticsRepairEligible: true,
      recoveryEligible: false,
      costNeedsReconciliation: false,
    });
  });

  it.each([
    {
      disposition: 'none' as const,
      expectedException: 'stopped',
      expectedCanContinue: true,
    },
    {
      disposition: 'continue_remaining' as const,
      expectedException: 'none',
      expectedCanContinue: false,
    },
  ])(
    'maps partial refund disposition $disposition into the fulfillment view',
    async ({ disposition, expectedException, expectedCanContinue }) => {
      const prisma = {
        order: {
          findFirst: vi.fn().mockResolvedValue({
            id: 5n,
            platformOrderId: 'order-5',
            buyerNick: null,
            receiverName: null,
            receiverPhoneEnc: null,
            amount: 20,
            status: 'paid',
            afterSaleStatus: 'partial_refund',
            afterSaleSyncedAt: new Date(),
            partialRefundDisposition: disposition,
            partialRefundDispositionAt: disposition === 'continue_remaining' ? new Date() : null,
            partialRefundDispositionNote:
              disposition === 'continue_remaining' ? '已核对剩余商品' : null,
            paidAt: new Date(),
            shop: { shopName: '测试店铺', platform: 'douyin' },
            publishedProduct: { title: '测试商品' },
            items: [
              { refundStatusRaw: 3, afterSaleStatusRaw: 12 },
              { refundStatusRaw: null, afterSaleStatusRaw: null },
            ],
            purchaseOrders: [],
          }),
        },
      } as unknown as PrismaService;
      const service = new OrderService(
        prisma,
        new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
        authConfig(),
      );

      const result = await service.getOne(USER, '5');

      expect(result.fulfillmentExceptionStatus).toBe(expectedException);
      expect(result.partialRefundCanContinue).toBe(expectedCanContinue);
      expect(result.partialRefundDisposition).toBe(disposition);
    },
  );

  it('exposes a refund amount only when it matches the current after-sale fingerprint', async () => {
    const fingerprint = 'a'.repeat(64);
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          platformOrderId: 'order-5',
          buyerNick: null,
          receiverName: null,
          receiverPhoneEnc: null,
          amount: 20,
          status: 'shipped',
          afterSaleStatus: 'none',
          afterSaleSyncedAt: new Date(),
          partialRefundDisposition: 'none',
          partialRefundFingerprint: fingerprint,
          partialRefundDispositionAt: null,
          partialRefundDispositionNote: null,
          refundAmount: 2,
          refundAmountFingerprint: fingerprint,
          refundAmountConfirmedAt: new Date(),
          refundAmountNote: '已核对价保退款',
          paidAt: new Date(),
          shop: { shopName: '测试店铺', platform: 'douyin' },
          publishedProduct: { title: '测试商品' },
          items: [{ refundStatusRaw: 3, afterSaleTypeRaw: 6 }],
          purchaseOrders: [],
        }),
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    const result = await service.getOne(USER, '5');

    expect(result).toMatchObject({
      refundAmount: 2,
      refundAmountConfirmed: true,
      refundAmountNeedsConfirmation: false,
      refundAmountNote: '已核对价保退款',
    });
  });
});

describe('OrderService.resolvePurchaseException', () => {
  it('records the operator resolution note for the current tenant', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          exceptionStatus: 'action_required',
          exceptionRevision: 3,
          orderId1688: '900001',
          priorIncurredCost: 0,
          retryEligible: false,
          everShipped: false,
          status: 'awaiting_payment',
          order: {
            status: 'refunded',
            afterSaleStatus: 'refunded',
            partialRefundDisposition: 'none',
          },
        }),
        updateMany,
      },
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          platformOrderId: 'order-5',
          buyerNick: null,
          receiverName: null,
          receiverPhoneEnc: null,
          amount: 10,
          status: 'refunded',
          afterSaleStatus: 'refunded',
          afterSaleSyncedAt: new Date(),
          partialRefundDisposition: 'none',
          partialRefundDispositionAt: null,
          partialRefundDispositionNote: null,
          paidAt: new Date(),
          shop: { shopName: '测试店铺', platform: 'douyin' },
          publishedProduct: { title: '测试商品' },
          items: [],
          purchaseOrders: [
            {
              id: 7n,
              outOrderId: 'supplier-5-a',
              orderId1688: '900001',
              paymentMode: 'manual',
              purchaseCost: 10,
              reconciledCost: 0,
              status: 'awaiting_payment',
              trackingNo: null,
              carrier: null,
              exceptionStatus: 'resolved',
              exceptionRevision: 3,
              exceptionReason: '销售订单已退款，请人工取消',
              exceptionDetectedAt: new Date(),
              exceptionResolvedAt: new Date(),
              exceptionResolutionNote: '已在 1688 取消未付款订单',
              shipments: [],
            },
          ],
        }),
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    const result = await service.resolvePurchaseException(
      USER,
      '5',
      '7',
      0,
      3,
      '  已在 1688 取消未付款订单  ',
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 7n,
        orderId: 5n,
        exceptionStatus: 'action_required',
        exceptionRevision: 3,
        order: { shop: { userId: 1n } },
      },
      data: {
        exceptionStatus: 'resolved',
        reconciledCost: 0,
        exceptionResolvedAt: expect.any(Date),
        exceptionResolutionNote: '已在 1688 取消未付款订单',
      },
    });
    expect(result.fulfillmentExceptionStatus).toBe('resolved');
    expect(result.purchases[0]).toMatchObject({
      reconciledCost: 0,
      costReconciled: true,
      exceptionRevision: 3,
    });
  });

  it('rejects generic cost resolution for a settled shipment anomaly', async () => {
    const updateMany = vi.fn();
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          exceptionStatus: 'action_required',
          exceptionRevision: 4,
          orderId1688: '900001',
          priorIncurredCost: 0,
          retryEligible: false,
          everShipped: true,
          status: 'shipped',
          order: {
            status: 'shipped',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          },
        }),
        updateMany,
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    await expect(
      service.resolvePurchaseException(USER, '5', '7', 12, 4, '已核对成本'),
    ).rejects.toThrow('请使用更新抖店物流操作');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a cost resolution submitted for an older exception event', async () => {
    const updateMany = vi.fn();
    const prisma = {
      purchaseOrder: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ exceptionStatus: 'action_required', exceptionRevision: 4 }),
        updateMany,
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    await expect(
      service.resolvePurchaseException(USER, '5', '7', 0, 3, '旧事件的取消处理结果'),
    ).rejects.toThrow('采购异常已更新，请刷新订单后重新核销');
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('OrderService.retryFailedPurchase', () => {
  it('archives the failed remote attempt and restores the sales order for a new purchase', async () => {
    const purchaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const attemptCreate = vi.fn().mockResolvedValue({ id: 21n });
    const shipmentDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback) =>
      callback({
        purchaseOrder: { updateMany: purchaseUpdateMany },
        purchaseOrderAttempt: { create: attemptCreate },
        purchaseShipment: { deleteMany: shipmentDeleteMany },
        order: { updateMany: orderUpdateMany },
      }),
    );
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          attemptNo: 1,
          attemptStartedAt: new Date('2026-07-21T01:00:00.000Z'),
          outOrderId: 'supplier-5-a',
          orderId1688: '900001',
          status: 'failed',
          purchaseCost: 10,
          priorIncurredCost: 0,
          failureReason: '1688 采购单状态：cancel',
          retryEligible: true,
          exceptionStatus: 'action_required',
          exceptionRevision: 2,
          order: {
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          },
        }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );
    vi.spyOn(service, 'getOne').mockResolvedValue({ status: 'paid' } as never);

    await expect(
      service.retryFailedPurchase(USER, '5', '7', 2.5, 2, '卖家取消后已全额退款'),
    ).resolves.toMatchObject({ status: 'paid' });

    expect(purchaseUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 7n,
        orderId: 5n,
        outOrderId: 'supplier-5-a',
        orderId1688: '900001',
        status: 'failed',
        attemptNo: 1,
        retryEligible: true,
        exceptionRevision: 2,
      }),
      data: expect.objectContaining({
        attemptNo: { increment: 1 },
        priorIncurredCost: { increment: 2.5 },
        outOrderId: 'supplier-5-a-r2',
        orderId1688: null,
        status: 'pending',
        retryEligible: false,
        exceptionStatus: 'none',
      }),
    });
    expect(attemptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purchaseOrderId: 7n,
        attemptNo: 1,
        outOrderId: 'supplier-5-a',
        orderId1688: '900001',
        actualCost: 2.5,
        resolutionNote: '卖家取消后已全额退款',
      }),
    });
    expect(shipmentDeleteMany).toHaveBeenCalledWith({ where: { purchaseOrderId: 7n } });
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 5n,
        status: 'purchasing',
        OR: [
          { afterSaleStatus: { in: ['none', 'failed'] } },
          {
            afterSaleStatus: 'partial_refund',
            partialRefundDisposition: 'continue_remaining',
          },
        ],
      },
      data: { status: 'paid' },
    });
  });
});

describe('OrderService.resumePurchaseLogistics', () => {
  it('archives and clears stale packages before reopening remote logistics validation', async () => {
    const purchaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const recoveryCreate = vi.fn().mockResolvedValue({ id: 31n });
    const shipmentDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback) =>
      callback({
        purchaseOrder: { updateMany: purchaseUpdateMany },
        purchaseOrderRecovery: { create: recoveryCreate },
        purchaseShipment: { deleteMany: shipmentDeleteMany },
      }),
    );
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          outOrderId: 'supplier-5-a',
          orderId1688: '900001',
          status: 'failed',
          retryEligible: false,
          everShipped: true,
          exceptionStatus: 'action_required',
          exceptionRevision: 4,
          shipments: [
            {
              trackingNo: 'OLD111',
              carrier: '顺丰速运',
              status: 'ACCEPT',
              items: [{ orderItemId: 11n, quantity: 1 }],
            },
          ],
          order: {
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          },
        }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );
    vi.spyOn(service, 'getOne').mockResolvedValue({ status: 'purchasing' } as never);

    await expect(
      service.resumePurchaseLogistics(USER, '5', '7', 4, '已在 1688 更换物流，等待重新同步'),
    ).resolves.toMatchObject({ status: 'purchasing' });

    expect(purchaseUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 7n,
        orderId: 5n,
        orderId1688: '900001',
        status: 'failed',
        retryEligible: false,
        everShipped: true,
        exceptionStatus: 'action_required',
        exceptionRevision: 4,
      }),
      data: {
        status: 'paid',
        trackingNo: null,
        carrier: null,
        failureReason: null,
        syncRevision: { increment: 1 },
        exceptionStatus: 'none',
        exceptionRevision: { increment: 1 },
        exceptionCode: null,
        exceptionReason: null,
        exceptionDetectedAt: null,
        exceptionResolvedAt: null,
        exceptionResolutionNote: null,
      },
    });
    expect(recoveryCreate).toHaveBeenCalledWith({
      data: {
        purchaseOrderId: 7n,
        operatorUserId: 1n,
        exceptionRevision: 4,
        outOrderId: 'supplier-5-a',
        orderId1688: '900001',
        previousStatus: 'failed',
        previousShipments: [
          {
            trackingNo: 'OLD111',
            carrier: '顺丰速运',
            status: 'ACCEPT',
            items: [{ orderItemId: '11', quantity: 1 }],
          },
        ],
        note: '已在 1688 更换物流，等待重新同步',
      },
    });
    expect(shipmentDeleteMany).toHaveBeenCalledWith({ where: { purchaseOrderId: 7n } });
  });
});

describe('OrderService.confirmRefundAmount', () => {
  it('binds the manually checked amount to the current after-sale fingerprint and tenant', async () => {
    const fingerprint = 'a'.repeat(64);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          amount: 100,
          status: 'shipped',
          partialRefundFingerprint: fingerprint,
          items: [{ refundStatusRaw: 3 }],
        }),
        updateMany,
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );
    vi.spyOn(service, 'getOne').mockResolvedValue({ orderId: '5' } as OrderView);

    await expect(
      service.confirmRefundAmount(USER, '5', 12.34, '  已按抖店后台退款记录核对  '),
    ).resolves.toMatchObject({ orderId: '5' });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 5n,
        status: 'shipped',
        amount: 100,
        partialRefundFingerprint: fingerprint,
        shop: { userId: 1n },
      },
      data: {
        refundAmount: 12.34,
        refundAmountFingerprint: fingerprint,
        refundAmountConfirmedAt: expect.any(Date),
        refundAmountNote: '已按抖店后台退款记录核对',
      },
    });
  });

  it('rejects a refund amount that would turn a partial refund into a full refund', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          amount: 100,
          status: 'paid',
          partialRefundFingerprint: 'a'.repeat(64),
          items: [{ refundStatusRaw: 3 }],
        }),
        updateMany: vi.fn(),
      },
    } as unknown as PrismaService;
    const service = new OrderService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      authConfig(),
    );

    await expect(service.confirmRefundAmount(USER, '5', 100, '后台核对结果')).rejects.toThrow(
      '部分退款累计金额必须小于订单实付金额',
    );
  });
});
