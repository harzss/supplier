import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { FulfillmentService } from './fulfillment.service';
import type { OrderService } from './order.service';

const USER: CurrentUser = { userId: 1n, plan: 'pro' };

describe('FulfillmentService token usage', () => {
  it('allows deterministic mock purchasing only for demo shops', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: 'demo-douyin-1',
            accessTokenEnc: null,
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: [{ quantity: 2 }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      purchaseOrder: {
        upsert: vi.fn().mockResolvedValue({ id: 11n }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const orders = {
      getOne: vi.fn().mockResolvedValue({ status: 'shipped' }),
    } as unknown as OrderService;
    const getAccessToken = vi.fn();
    const shopTokens = { getAccessToken } as unknown as ShopTokenService;
    const shipOrder = vi.fn().mockResolvedValue(undefined);
    const adapters = {
      create: vi.fn().mockReturnValue({ shipOrder }),
    } as unknown as PlatformAdapterFactory;
    const service = new FulfillmentService(
      prisma,
      orders,
      shopTokens,
      adapters,
      { advance: vi.fn() } as never,
      { refreshOrder: vi.fn() } as never,
    );

    const result = await service.fulfill(USER, '5');

    expect(getAccessToken).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.upsert).toHaveBeenCalledWith({
      where: { uk_order_supplier_purchase: { orderId: 5n, supplierKey: 'demo' } },
      create: expect.objectContaining({
        supplierKey: 'demo',
        outOrderId: 'demo-5',
        purchaseCost: 37.8,
      }),
      update: expect.objectContaining({ purchaseCost: 37.8 }),
    });
    expect(prisma.purchaseOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 11n } }),
    );
    expect(shipOrder).toHaveBeenCalledWith(
      'mock-token',
      expect.objectContaining({ platformOrderId: 'order-1', carrier: '顺丰速运' }),
    );
    expect(result.status).toBe('shipped');
  });

  it('fails closed for paid real-shop orders when real purchasing is unavailable', async () => {
    const orderUpdate = vi.fn();
    const purchaseUpsert = vi.fn();
    const purchaseUpdate = vi.fn();
    const getAccessToken = vi.fn();
    const createAdapter = vi.fn();
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          })
          .mockResolvedValueOnce({ status: 'shipped' }),
        update: orderUpdate,
      },
      purchaseOrder: { upsert: purchaseUpsert, update: purchaseUpdate },
    } as unknown as PrismaService;
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn() } as unknown as OrderService,
      { getAccessToken } as unknown as ShopTokenService,
      { create: createAdapter } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockRejectedValue(new ServiceUnavailableException('真实采购开关未启用')),
      } as never,
      { refreshOrder: vi.fn() } as never,
    );

    const fulfillment = service.fulfill(USER, '5');
    await expect(fulfillment).rejects.toMatchObject({
      constructor: ServiceUnavailableException,
      message: expect.stringContaining('真实采购开关未启用'),
    });
    expect(createAdapter).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(purchaseUpsert).not.toHaveBeenCalled();
    expect(purchaseUpdate).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('surfaces expired authorization instead of marking the order shipped', async () => {
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [{ trackingNo: 'SF123', carrier: '顺丰速运' }],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          })
          .mockResolvedValueOnce({ status: 'shipped' }),
        updateMany: orderUpdateMany,
      },
      purchaseOrder: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const shopTokens = {
      getAccessToken: vi.fn().mockRejectedValue(new UnauthorizedException('请重新授权')),
    } as unknown as ShopTokenService;
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn() } as unknown as OrderService,
      shopTokens,
      {
        create: vi.fn().mockReturnValue({ shipPackages: vi.fn() }),
      } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockResolvedValue({
          requestId: 'request-1',
          packages: [
            {
              trackingNo: 'SF123',
              carrier: '顺丰速运',
              items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
            },
          ],
        }),
      } as never,
      { refreshOrder: vi.fn() } as never,
    );

    await expect(service.fulfill(USER, '5')).rejects.toThrow('请重新授权');
    expect(orderUpdateMany).not.toHaveBeenCalled();
  });

  it('retries only the multi-package platform callback after 1688 shipments are ready', async () => {
    const purchaseUpsert = vi.fn();
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [{ trackingNo: 'SF123', carrier: '顺丰速运' }],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          })
          .mockResolvedValueOnce({ status: 'shipped' }),
        updateMany: orderUpdateMany,
      },
      purchaseOrder: { upsert: purchaseUpsert, update: vi.fn() },
    } as unknown as PrismaService;
    const shipPackages = vi.fn().mockResolvedValue(undefined);
    const resolveProducerCase = vi.fn().mockResolvedValue(undefined);
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn().mockResolvedValue({ status: 'shipped' }) } as unknown as OrderService,
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ shipPackages }) } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockResolvedValue({
          requestId: 'request-1',
          packages: [
            {
              trackingNo: 'SF123',
              carrier: '顺丰速运',
              items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
            },
          ],
        }),
      } as never,
      { refreshOrder: vi.fn() } as never,
      { recordProducerCase: vi.fn(), resolveProducerCase } as never,
    );

    await service.fulfill(USER, '5');

    expect(purchaseUpsert).not.toHaveBeenCalled();
    expect(shipPackages).toHaveBeenCalledWith('plain-token', {
      platformOrderId: 'order-1',
      requestId: 'request-1',
      packages: [
        {
          trackingNo: 'SF123',
          carrier: '顺丰速运',
          items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
        },
      ],
    });
    expect(orderUpdateMany).not.toHaveBeenCalled();
    expect(resolveProducerCase).toHaveBeenCalledTimes(2);
    expect(resolveProducerCase).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1n,
        code: 'sales_platform_logistics_status_unknown',
        sourceType: 'order',
        sourceId: 5n,
        evidence: { requestId: 'request-1', platformStatus: 'shipped' },
      }),
    );
  });

  it('records a durable case when the sales-platform logistics callback fails', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi.fn().mockResolvedValue({
          status: 'purchasing',
          afterSaleStatus: 'none',
          partialRefundDisposition: 'none',
        }),
      },
    } as unknown as PrismaService;
    const callbackError = new ServiceUnavailableException('平台暂时不可用');
    const shipPackages = vi.fn().mockRejectedValue(callbackError);
    const recordProducerCase = vi.fn().mockResolvedValue(undefined);
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn() } as unknown as OrderService,
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ shipPackages }) } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockResolvedValue({
          requestId: 'request-1',
          packages: [
            {
              trackingNo: 'SF123',
              carrier: '顺丰速运',
              items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
            },
          ],
        }),
      } as never,
      { refreshOrder: vi.fn().mockResolvedValue(undefined) } as never,
      { recordProducerCase, resolveProducerCase: vi.fn() } as never,
    );

    await expect(service.fulfill(USER, '5')).rejects.toBe(callbackError);

    expect(recordProducerCase).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1n,
        code: 'sales_platform_logistics_callback_failed',
        sourceType: 'order',
        sourceId: 5n,
        subjectLabel: '销售订单 order-1',
        reason: '平台暂时不可用',
      }),
    );
    expect(recordProducerCase.mock.calls[0]?.[0].sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('closes logistics cases when the next authoritative readback proves shipment succeeded', async () => {
    const baseOrder = {
      id: 5n,
      status: 'purchasing',
      afterSaleStatus: 'none',
      partialRefundDisposition: 'none',
      platformOrderId: 'order-1',
      shop: {
        id: 9n,
        platform: 'douyin',
        platformShopId: '4463798',
        accessTokenEnc: 'encrypted-token',
      },
      purchaseOrders: [],
      publishedProduct: { costPrice: 18.9 },
      skuInfo: { quantity: 1 },
    };
    const prisma = {
      order: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(baseOrder)
          .mockResolvedValueOnce({ ...baseOrder, status: 'shipped' }),
      },
    } as unknown as PrismaService;
    const advance = vi.fn();
    const resolveProducerCase = vi.fn().mockResolvedValue(undefined);
    const refreshOrder = vi.fn().mockResolvedValue(undefined);
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn().mockResolvedValue({ status: 'shipped' }) } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn() } as unknown as PlatformAdapterFactory,
      { advance } as never,
      { refreshOrder } as never,
      { recordProducerCase: vi.fn(), resolveProducerCase } as never,
    );

    await expect(service.fulfill(USER, '5')).resolves.toMatchObject({ status: 'shipped' });

    expect(refreshOrder).toHaveBeenCalledTimes(1);
    expect(advance).not.toHaveBeenCalled();
    expect(resolveProducerCase).toHaveBeenCalledTimes(2);
    expect(resolveProducerCase).toHaveBeenCalledWith({
      userId: 1n,
      code: 'sales_platform_logistics_callback_failed',
      sourceType: 'order',
      sourceId: 5n,
      evidence: { platformStatus: 'shipped' },
    });
    expect(resolveProducerCase).toHaveBeenCalledWith({
      userId: 1n,
      code: 'sales_platform_logistics_status_unknown',
      sourceType: 'order',
      sourceId: 5n,
      evidence: { platformStatus: 'shipped' },
    });
  });

  it('keeps fulfillment unresolved when platform readback fails after the callback', async () => {
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi.fn().mockResolvedValue({
          status: 'purchasing',
          afterSaleStatus: 'none',
          partialRefundDisposition: 'none',
        }),
      },
    } as unknown as PrismaService;
    const refreshOrder = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ServiceUnavailableException('平台回读超时'));
    const recordProducerCase = vi.fn().mockResolvedValue(undefined);
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn() } as unknown as OrderService,
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({ shipPackages: vi.fn().mockResolvedValue(undefined) }),
      } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockResolvedValue({
          requestId: 'request-1',
          packages: [
            {
              trackingNo: 'SF123',
              carrier: '顺丰速运',
              items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
            },
          ],
        }),
      } as never,
      { refreshOrder } as never,
      { recordProducerCase, resolveProducerCase: vi.fn() } as never,
    );

    await expect(service.fulfill(USER, '5')).rejects.toThrow('物流已提交，但平台状态暂时无法确认');
    expect(recordProducerCase).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'sales_platform_logistics_status_unknown',
        reason: '平台回读超时',
      }),
    );
  });

  it('does not overwrite a refund that wins after the platform logistics callback', async () => {
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
          })
          .mockResolvedValueOnce({ status: 'refunded' }),
        updateMany: orderUpdateMany,
      },
    } as unknown as PrismaService;
    const shipPackages = vi.fn().mockResolvedValue(undefined);
    const refreshOrder = vi.fn().mockResolvedValue(undefined);
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn().mockResolvedValue({ status: 'refunded' }) } as unknown as OrderService,
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ shipPackages }) } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockResolvedValue({
          requestId: 'request-1',
          packages: [
            {
              trackingNo: 'SF123',
              carrier: '顺丰速运',
              items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
            },
          ],
        }),
      } as never,
      { refreshOrder } as never,
    );

    await expect(service.fulfill(USER, '5')).resolves.toMatchObject({ status: 'refunded' });

    expect(shipPackages).toHaveBeenCalledTimes(1);
    expect(orderUpdateMany).not.toHaveBeenCalled();
    expect(refreshOrder).toHaveBeenCalledTimes(3);
  });

  it('does not send logistics when the sales order becomes refunded during 1688 synchronization', async () => {
    const shipPackages = vi.fn();
    const getAccessToken = vi.fn();
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
        findUnique: vi.fn().mockResolvedValue({ status: 'refunded' }),
        update: vi.fn(),
      },
    } as unknown as PrismaService;
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn().mockResolvedValue({ status: 'refunded' }) } as unknown as OrderService,
      { getAccessToken } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ shipPackages }) } as unknown as PlatformAdapterFactory,
      {
        advance: vi.fn().mockResolvedValue({
          requestId: 'request-1',
          packages: [
            {
              trackingNo: 'SF123',
              carrier: '顺丰速运',
              items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
            },
          ],
        }),
      } as never,
      { refreshOrder: vi.fn() } as never,
    );

    await expect(service.fulfill(USER, '5')).resolves.toMatchObject({ status: 'refunded' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(shipPackages).not.toHaveBeenCalled();
  });

  it('pauses purchasing while a platform after-sale request is active', async () => {
    const advance = vi.fn();
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          afterSaleStatus: 'pending',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
      },
    } as unknown as PrismaService;
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn().mockResolvedValue({ status: 'paid' }) } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn().mockReturnValue({}) } as unknown as PlatformAdapterFactory,
      { advance } as never,
      { refreshOrder: vi.fn() } as never,
    );

    await expect(service.fulfill(USER, '5')).resolves.toMatchObject({ status: 'paid' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('resumes purchasing after the platform rejects the after-sale request', async () => {
    const advance = vi.fn().mockResolvedValue({ packages: [], requestId: null });
    const getOne = vi.fn().mockResolvedValue({ status: 'paid' });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          afterSaleStatus: 'failed',
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          purchaseOrders: [],
          publishedProduct: { costPrice: 18.9 },
          skuInfo: { quantity: 1 },
        }),
      },
    } as unknown as PrismaService;
    const refreshOrder = vi.fn();
    const service = new FulfillmentService(
      prisma,
      { getOne } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn().mockReturnValue({}) } as unknown as PlatformAdapterFactory,
      { advance } as never,
      { refreshOrder } as never,
    );

    await expect(service.fulfill(USER, '5')).resolves.toMatchObject({ status: 'paid' });

    expect(refreshOrder).toHaveBeenCalledWith(USER, '5');
    expect(advance).toHaveBeenCalledWith(USER, 5n);
  });

  it('records a safe decision to continue only the non-refunded items', async () => {
    const partialOrder = {
      id: 5n,
      status: 'paid',
      afterSaleStatus: 'partial_refund',
      partialRefundDisposition: 'none',
      partialRefundFingerprint: 'a'.repeat(64),
      shop: {
        id: 9n,
        userId: 1n,
        platform: 'douyin',
        platformShopId: '4463798',
        accessTokenEnc: 'encrypted-token',
      },
      items: [
        { refundStatusRaw: 3, afterSaleStatusRaw: 12 },
        {
          refundStatusRaw: null as number | null,
          afterSaleStatusRaw: null as number | null,
        },
      ],
      purchaseOrders: [
        { id: 11n, orderId1688: null, status: 'pending', exceptionStatus: 'stopped' },
      ],
    };
    const purchaseDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(partialOrder) },
      $transaction: vi.fn((callback) =>
        callback({
          purchaseOrder: {
            count: vi.fn().mockResolvedValue(0),
            deleteMany: purchaseDeleteMany,
            updateMany: vi.fn(),
          },
          order: { updateMany: orderUpdateMany },
        }),
      ),
    } as unknown as PrismaService;
    const refreshOrder = vi.fn();
    const getOne = vi.fn().mockResolvedValue({
      status: 'paid',
      partialRefundDisposition: 'continue_remaining',
    });
    const service = new FulfillmentService(
      prisma,
      { getOne } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn().mockReturnValue({}) } as unknown as PlatformAdapterFactory,
      {} as never,
      { refreshOrder } as never,
    );

    await expect(
      service.resolvePartialRefund(USER, '5', 'continue_remaining', '  已核对剩余商品  '),
    ).resolves.toMatchObject({ partialRefundDisposition: 'continue_remaining' });

    expect(refreshOrder).toHaveBeenCalledWith(USER, '5');
    expect(purchaseDeleteMany).toHaveBeenCalledWith({
      where: { orderId: 5n, orderId1688: null, status: { in: ['pending', 'failed'] } },
    });
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 5n,
        status: 'paid',
        afterSaleStatus: 'partial_refund',
        partialRefundDisposition: 'none',
        partialRefundFingerprint: 'a'.repeat(64),
        shop: { userId: 1n },
      },
      data: {
        partialRefundDisposition: 'continue_remaining',
        partialRefundDispositionAt: expect.any(Date),
        partialRefundDispositionNote: '已核对剩余商品',
      },
    });

    partialOrder.items[1]!.refundStatusRaw = 1;
    await expect(
      service.resolvePartialRefund(USER, '5', 'continue_remaining', '仍有子单退款处理中'),
    ).rejects.toThrow('仍有未退款子单处于售后处理中');
  });

  it('rejects automatic continuation after a remote 1688 purchase exists', async () => {
    const orderUpdateMany = vi.fn();
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          afterSaleStatus: 'partial_refund',
          partialRefundDisposition: 'none',
          partialRefundFingerprint: 'a'.repeat(64),
          shop: {
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          items: [
            { refundStatusRaw: 3, afterSaleStatusRaw: 12 },
            { refundStatusRaw: null, afterSaleStatusRaw: null },
          ],
          purchaseOrders: [{ id: 11n, orderId1688: '900001', status: 'awaiting_payment' }],
        }),
      },
      $transaction: vi.fn((callback) =>
        callback({
          purchaseOrder: {
            count: vi.fn().mockResolvedValue(1),
            deleteMany: vi.fn(),
            updateMany: vi.fn(),
          },
          order: { updateMany: orderUpdateMany },
        }),
      ),
    } as unknown as PrismaService;
    const service = new FulfillmentService(
      prisma,
      { getOne: vi.fn() } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn().mockReturnValue({}) } as unknown as PlatformAdapterFactory,
      {} as never,
      { refreshOrder: vi.fn() } as never,
    );

    await expect(
      service.resolvePartialRefund(USER, '5', 'continue_remaining', '已核对剩余商品'),
    ).rejects.toThrow('1688 采购已创建或推进');
    expect(orderUpdateMany).not.toHaveBeenCalled();
  });

  it('records the operator decision to stop the whole order', async () => {
    const purchaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          afterSaleStatus: 'partial_refund',
          partialRefundDisposition: 'none',
          partialRefundFingerprint: 'b'.repeat(64),
          shop: {
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
          },
          items: [
            { refundStatusRaw: 3, afterSaleStatusRaw: 12 },
            { refundStatusRaw: null, afterSaleStatusRaw: null },
          ],
          purchaseOrders: [],
        }),
      },
      $transaction: vi.fn((callback) =>
        callback({
          purchaseOrder: { updateMany: purchaseUpdateMany },
          order: { updateMany: orderUpdateMany },
        }),
      ),
    } as unknown as PrismaService;
    const service = new FulfillmentService(
      prisma,
      {
        getOne: vi.fn().mockResolvedValue({ partialRefundDisposition: 'stop_all' }),
      } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn().mockReturnValue({}) } as unknown as PlatformAdapterFactory,
      {} as never,
      { refreshOrder: vi.fn() } as never,
    );

    await expect(
      service.resolvePartialRefund(USER, '5', 'stop_all', '剩余商品改由人工处理'),
    ).resolves.toMatchObject({ partialRefundDisposition: 'stop_all' });

    expect(purchaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orderId: 5n, orderId1688: null }),
        data: expect.objectContaining({ exceptionStatus: 'stopped' }),
      }),
    );
    expect(orderUpdateMany.mock.calls[0]![0].data).toMatchObject({
      partialRefundDisposition: 'stop_all',
      partialRefundDispositionNote: '剩余商品改由人工处理',
    });
  });

  it('returns the same decision idempotently and rejects overwriting it', async () => {
    const getOne = vi.fn().mockResolvedValue({ partialRefundDisposition: 'stop_all' });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'paid',
          afterSaleStatus: 'partial_refund',
          partialRefundDisposition: 'stop_all',
          partialRefundFingerprint: 'c'.repeat(64),
          shop: { platform: 'douyin', platformShopId: 'demo-douyin-1' },
          items: [],
          purchaseOrders: [],
        }),
      },
      $transaction: vi.fn(),
    } as unknown as PrismaService;
    const service = new FulfillmentService(
      prisma,
      { getOne } as unknown as OrderService,
      {} as ShopTokenService,
      { create: vi.fn().mockReturnValue({}) } as unknown as PlatformAdapterFactory,
      {} as never,
      { refreshOrder: vi.fn() } as never,
    );

    await expect(
      service.resolvePartialRefund(USER, '5', 'stop_all', '重复提交同一决定'),
    ).resolves.toMatchObject({ partialRefundDisposition: 'stop_all' });
    await expect(
      service.resolvePartialRefund(USER, '5', 'continue_remaining', '尝试覆盖原决定'),
    ).rejects.toThrow('当前部分退款状态已完成处置');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
