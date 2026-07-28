import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { createHash } from 'node:crypto';
import type { PlatformAdapterFactory } from '../shop/platform-adapter.factory';
import type { ShopTokenService } from '../shop/shop-token.service';
import { CryptoService } from '../../common/crypto.module';
import type { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import { OrderSyncService } from './order-sync.service';

const USER: CurrentUser = { userId: 1n, plan: 'pro' };

function runtimeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    DOUYIN_ORDER_SYNC_LOOKBACK_DAYS: 30,
    DOUYIN_ORDER_SYNC_MAX_PAGES: 100,
    DOUYIN_ORDER_SYNC_OVERLAP_SECONDS: 300,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function redis(setResult: 'OK' | null = 'OK'): Redis {
  return {
    set: vi.fn().mockResolvedValue(setResult),
    eval: vi.fn().mockResolvedValue(1),
  } as unknown as Redis;
}

describe('OrderSyncService', () => {
  it('rejects legacy demo shops before acquiring a sync lock in supabase auth mode', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const redisClient = redis();
    const service = new OrderSyncService(
      { shop: { findFirst } } as unknown as PrismaService,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      {} as ShopTokenService,
      {} as PlatformAdapterFactory,
      runtimeConfig({ AUTH_MODE: 'supabase' }),
      redisClient,
    );

    await expect(service.syncShop(1n, 9n)).rejects.toThrow('店铺不存在或授权已失效');
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 9n,
        userId: 1n,
        status: 'active',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
    });
    expect(redisClient.set).not.toHaveBeenCalled();
  });

  it('refreshes one order and treats refund_status=1 as an active after-sale hold', async () => {
    const orderUpsert = vi.fn().mockResolvedValue({ id: 20n });
    const orderItemUpsert = vi.fn().mockResolvedValue({});
    const getOrder = vi.fn().mockResolvedValue({
      platformOrderId: 'order-1',
      buyerNick: '',
      receiverName: '',
      receiverPhone: '',
      receiverAddress: '',
      amount: 10,
      status: 'paid',
      paidAt: new Date(),
      skuList: [
        {
          platformOrderItemId: 'sku-order-1',
          skuId: 'sku-1',
          title: '测试商品',
          quantity: 1,
          unitPrice: 10,
          refundStatus: 1,
        },
      ],
    });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          shopId: 9n,
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
            status: 'active',
          },
        }),
        findUnique: vi.fn().mockResolvedValue({ status: 'paid', afterSaleStatus: 'pending' }),
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(null), upsert: orderUpsert },
          orderItem: {
            upsert: orderItemUpsert,
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        }),
      ),
    } as unknown as PrismaService;
    const getAccessToken = vi.fn().mockResolvedValue('plain-token');
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({ listOrders: vi.fn(), getOrder }),
      } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await expect(service.refreshOrder(USER, '20')).resolves.toEqual({
      orderId: '20',
      status: 'paid',
      afterSaleStatus: 'pending',
    });

    expect(getAccessToken).toHaveBeenCalledWith(9n, 1n);
    expect(getOrder).toHaveBeenCalledWith('plain-token', 'order-1');
    expect(orderUpsert.mock.calls[0]![0].update.afterSaleStatus).toBe('pending');
    expect(orderItemUpsert.mock.calls[0]![0].create.refundStatusRaw).toBe(1);
  });

  it('rejects a mismatched order detail before writing another platform order', async () => {
    const publishedProductFindMany = vi.fn().mockResolvedValue([]);
    const orderUpsert = vi.fn().mockResolvedValue({ id: 21n });
    const transaction = vi.fn(async (callback) =>
      callback({
        order: { findUnique: vi.fn().mockResolvedValue(null), upsert: orderUpsert },
        orderItem: {
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
      }),
    );
    const getOrder = vi.fn().mockResolvedValue({
      platformOrderId: 'another-order',
      buyerNick: '',
      receiverName: '',
      receiverPhone: '',
      receiverAddress: '',
      amount: 10,
      status: 'paid',
      paidAt: new Date(),
      skuList: [
        {
          platformOrderItemId: 'another-order-item',
          skuId: 'sku-1',
          title: '测试商品',
          quantity: 1,
          unitPrice: 10,
        },
      ],
    });
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          shopId: 9n,
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
            status: 'active',
          },
        }),
        findUnique: vi.fn().mockResolvedValue({ status: 'paid', afterSaleStatus: 'none' }),
      },
      publishedProduct: { findMany: publishedProductFindMany },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({ listOrders: vi.fn(), getOrder }),
      } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await expect(service.refreshOrder(USER, '20')).rejects.toThrow('平台订单详情与请求订单不一致');

    expect(publishedProductFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('retries the order snapshot transaction after a serialization conflict', async () => {
    const conflict = Object.assign(new Error('transaction conflict'), { code: 'P2034' });
    const tx = {
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({ id: 20n }),
      },
      orderItem: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation((callback) => callback(tx));
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          shopId: 9n,
          platformOrderId: 'order-1',
          shop: {
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
            status: 'active',
          },
        }),
        findUnique: vi.fn().mockResolvedValue({ status: 'paid', afterSaleStatus: 'none' }),
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({
          listOrders: vi.fn(),
          getOrder: vi.fn().mockResolvedValue({
            platformOrderId: 'order-1',
            buyerNick: '',
            receiverName: '',
            receiverPhone: '',
            receiverAddress: '',
            amount: 10,
            status: 'paid',
            paidAt: new Date(),
            skuList: [
              {
                platformOrderItemId: 'sku-order-1',
                skuId: 'sku-1',
                title: '测试商品',
                quantity: 1,
                unitPrice: 10,
              },
            ],
          }),
        }),
      } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await expect(service.refreshOrder(USER, '20')).resolves.toMatchObject({ status: 'paid' });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('pulls real orders and encrypts receiver privacy before upsert', async () => {
    const orderUpsert = vi.fn().mockResolvedValue({ id: 20n });
    const orderItemUpsert = vi.fn().mockResolvedValue({});
    const orderItemDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const shopUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const shop = {
      id: 9n,
      userId: 1n,
      platform: 'douyin',
      platformShopId: '4463798',
      accessTokenEnc: 'encrypted-token',
      status: 'active',
    };
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue(shop),
        update: shopUpdate,
        updateMany: shopUpdate,
      },
      publishedProduct: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 7n,
            platformProductId: 'product-1',
            sourceProduct: { productId1688: '554456348334', supplierId: 'supplier-1688-1' },
          },
        ]),
      },
      $transaction: vi.fn(async (callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(null), upsert: orderUpsert },
          orderItem: { upsert: orderItemUpsert, deleteMany: orderItemDeleteMany },
        }),
      ),
    } as unknown as PrismaService;
    const crypto = new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService);
    const listOrders = vi.fn().mockResolvedValue([
      {
        platformOrderId: 'order-1',
        buyerNick: '买家A',
        receiverName: '张三',
        receiverPhone: '13811112222',
        receiverAddress: '浙江省杭州市余杭区文一西路 969 号',
        receiverAddressDetail: {
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          detail: '文一西路 969 号',
        },
        amount: 59.8,
        status: 'paid',
        paidAt: new Date('2026-07-16T08:00:00.000Z'),
        skuList: [
          {
            platformOrderItemId: 'sku-order-1',
            platformProductId: 'product-1',
            skuId: 'sku-1',
            sourceSkuId: '1688-spec-white-m',
            specs: { 颜色: '白色', 尺码: 'M' },
            title: '纯棉短袖',
            quantity: 2,
            unitPrice: 29.9,
          },
        ],
      },
    ]);
    const adapters = {
      create: vi.fn().mockReturnValue({ listOrders }),
    } as unknown as PlatformAdapterFactory;
    const shopTokens = {
      getAccessToken: vi.fn().mockResolvedValue('plain-token'),
    } as unknown as ShopTokenService;
    const service = new OrderSyncService(
      prisma,
      crypto,
      shopTokens,
      adapters,
      runtimeConfig(),
      redis(),
    );

    const result = await service.sync(USER, '9');

    expect(listOrders).toHaveBeenCalledWith(
      'plain-token',
      expect.objectContaining({
        cursor: '0',
        pageSize: 100,
        status: '105,2,101,3,4,5',
        startTime: expect.any(Date),
        endTime: expect.any(Date),
      }),
    );
    const args = orderUpsert.mock.calls[0]![0];
    expect(args.create.publishedProductId).toBe(7n);
    expect(args.create.receiverPhoneEnc).not.toContain('13811112222');
    expect(crypto.decrypt(args.create.receiverPhoneEnc)).toBe('13811112222');
    expect(args.create.receiverName).toBe('张*');
    expect(crypto.decrypt(args.create.receiverNameEnc)).toBe('张三');
    expect(crypto.decrypt(args.create.receiverAddressEnc)).toContain('文一西路');
    expect(JSON.parse(crypto.decrypt(args.create.receiverAddressDetailEnc))).toEqual({
      province: '浙江省',
      city: '杭州市',
      area: '余杭区',
      detail: '文一西路 969 号',
    });
    expect(orderItemDeleteMany).toHaveBeenCalledWith({
      where: { orderId: 20n, platformOrderItemId: { notIn: ['sku-order-1'] } },
    });
    expect(orderItemUpsert).toHaveBeenCalledWith({
      where: {
        uk_order_platform_item: { orderId: 20n, platformOrderItemId: 'sku-order-1' },
      },
      create: expect.objectContaining({
        orderId: 20n,
        publishedProductId: 7n,
        sourceOfferId: '554456348334',
        sourceSupplierId: 'supplier-1688-1',
        sourceSpecId: '1688-spec-white-m',
        sourceSpecRequired: true,
      }),
      update: expect.objectContaining({
        sourceOfferId: '554456348334',
        sourceSupplierId: 'supplier-1688-1',
        sourceSpecId: '1688-spec-white-m',
      }),
    });
    expect(result).toEqual({ shopId: '9', synced: 1, skipped: 0 });
  });

  it('does not downgrade or rewrite procurement items after a purchase order exists', async () => {
    const orderUpsert = vi.fn().mockResolvedValue({ id: 20n });
    const orderItemUpsert = vi.fn();
    const orderItemDeleteMany = vi.fn();
    const orderItemUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const shopUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
        }),
        update: shopUpdate,
        updateMany: shopUpdate,
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback) =>
        callback({
          order: {
            findUnique: vi.fn().mockResolvedValue({
              id: 20n,
              status: 'purchasing',
              items: [{ platformOrderItemId: 'sku-order-1' }],
              purchaseOrders: [{ id: 30n }],
            }),
            upsert: orderUpsert,
          },
          orderItem: {
            upsert: orderItemUpsert,
            deleteMany: orderItemDeleteMany,
            updateMany: orderItemUpdateMany,
          },
        }),
      ),
    } as unknown as PrismaService;
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({
          listOrders: vi.fn().mockResolvedValue([
            {
              platformOrderId: 'order-1',
              buyerNick: '',
              receiverName: '',
              receiverPhone: '',
              receiverAddress: '',
              amount: 10,
              status: 'paid',
              paidAt: new Date(),
              skuList: [
                {
                  platformOrderItemId: 'sku-order-1',
                  skuId: 'sku-1',
                  title: '测试商品',
                  quantity: 1,
                  unitPrice: 10,
                },
              ],
            },
          ]),
        }),
      } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await service.sync(USER, '9');

    expect(orderUpsert.mock.calls[0]![0].update.status).toBe('purchasing');
    expect(orderItemDeleteMany).not.toHaveBeenCalled();
    expect(orderItemUpsert).not.toHaveBeenCalled();
    expect(orderItemUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('fails closed when platform child orders diverge from the procurement snapshot', async () => {
    const shopUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const orderItemUpdateMany = vi.fn();
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
        }),
        update: shopUpdate,
        updateMany: shopUpdate,
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn((callback) =>
        callback({
          order: {
            findUnique: vi.fn().mockResolvedValue({
              id: 20n,
              status: 'purchasing',
              items: [{ platformOrderItemId: 'sku-order-1' }],
              purchaseOrders: [{ id: 30n }],
            }),
            upsert: vi.fn().mockResolvedValue({ id: 20n }),
          },
          orderItem: { updateMany: orderItemUpdateMany },
        }),
      ),
    } as unknown as PrismaService;
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({
          listOrders: vi.fn().mockResolvedValue([
            {
              platformOrderId: 'order-1',
              buyerNick: '',
              receiverName: '',
              receiverPhone: '',
              receiverAddress: '',
              amount: 10,
              status: 'shipped',
              paidAt: new Date(),
              skuList: [
                {
                  platformOrderItemId: 'sku-order-unknown',
                  skuId: 'sku-unknown',
                  title: '未知子单',
                  quantity: 1,
                  unitPrice: 10,
                },
              ],
            },
          ]),
        }),
      } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await expect(service.sync(USER, '9')).rejects.toThrow(
      '平台订单子单与采购快照不一致，已停止同步并保留原状态',
    );

    expect(orderItemUpdateMany).not.toHaveBeenCalled();
    expect(shopUpdate.mock.calls.some(([args]) => args.data.lastOrderSyncAt !== undefined)).toBe(
      false,
    );
  });

  it.each([
    {
      caseName: 'turns the sales order into refunded when every platform item is refunded',
      skuList: [
        {
          platformOrderItemId: 'sku-order-1',
          skuId: 'sku-1',
          title: '测试商品 1',
          quantity: 1,
          unitPrice: 10,
          afterSaleStatus: 12,
          refundStatus: 3,
        },
      ],
      expectedStatus: 'refunded',
      expectedAfterSaleStatus: 'refunded',
      expectedPurchaseException: true,
    },
    {
      caseName: 'keeps the platform order status when only some items are refunded',
      skuList: [
        {
          platformOrderItemId: 'sku-order-1',
          skuId: 'sku-1',
          title: '测试商品 1',
          quantity: 1,
          unitPrice: 10,
          afterSaleStatus: 12,
          refundStatus: 3,
        },
        {
          platformOrderItemId: 'sku-order-2',
          skuId: 'sku-2',
          title: '测试商品 2',
          quantity: 1,
          unitPrice: 10,
        },
      ],
      expectedStatus: 'shipped',
      expectedAfterSaleStatus: 'partial_refund',
      expectedPurchaseException: true,
    },
    {
      caseName: 'keeps price-protected items in fulfillment despite a successful refund',
      skuList: [
        {
          platformOrderItemId: 'sku-order-1',
          skuId: 'sku-1',
          title: '价保商品',
          quantity: 1,
          unitPrice: 10,
          afterSaleStatus: 12,
          afterSaleType: 6,
          refundStatus: 3,
        },
      ],
      expectedStatus: 'shipped',
      expectedAfterSaleStatus: 'none',
      expectedPurchaseException: false,
    },
  ])(
    '$caseName',
    async ({ skuList, expectedStatus, expectedAfterSaleStatus, expectedPurchaseException }) => {
      const orderUpsert = vi.fn().mockResolvedValue({ id: 20n });
      const purchaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const prisma = {
        shop: {
          findFirst: vi.fn().mockResolvedValue({
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
            status: 'active',
          }),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
        $transaction: vi.fn(async (callback) =>
          callback({
            order: {
              findUnique: vi.fn().mockResolvedValue({
                id: 20n,
                status: 'purchasing',
                items: skuList.map((sku) => ({
                  platformOrderItemId: sku.platformOrderItemId,
                })),
                purchaseOrders: [{ id: 30n }],
              }),
              upsert: orderUpsert,
            },
            purchaseOrder: { updateMany: purchaseUpdateMany },
            orderItem: {
              upsert: vi.fn(),
              deleteMany: vi.fn(),
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
          }),
        ),
      } as unknown as PrismaService;
      const service = new OrderSyncService(
        prisma,
        new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
        { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
        {
          create: vi.fn().mockReturnValue({
            listOrders: vi.fn().mockResolvedValue([
              {
                platformOrderId: 'order-1',
                buyerNick: '',
                receiverName: '',
                receiverPhone: '',
                receiverAddress: '',
                amount: 10,
                status: 'shipped',
                paidAt: new Date(),
                skuList,
              },
            ]),
          }),
        } as unknown as PlatformAdapterFactory,
        runtimeConfig(),
        redis(),
      );

      await service.sync(USER, '9');

      expect(orderUpsert.mock.calls[0]![0].update.status).toBe(expectedStatus);
      expect(orderUpsert.mock.calls[0]![0].update.afterSaleStatus).toBe(expectedAfterSaleStatus);
      expect(orderUpsert.mock.calls[0]![0].update.partialRefundFingerprint).toEqual(
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
      expect(orderUpsert.mock.calls[0]![0].update).toMatchObject({
        refundAmount: null,
        refundAmountFingerprint: null,
        refundAmountConfirmedAt: null,
        refundAmountNote: null,
      });
      if (expectedAfterSaleStatus === 'partial_refund') {
        expect(orderUpsert.mock.calls[0]![0].update).toMatchObject({
          partialRefundDisposition: 'none',
          partialRefundFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
      }
      if (expectedPurchaseException) {
        expect(purchaseUpdateMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              orderId: 20n,
              exceptionStatus: { in: ['none', 'resolved', 'action_required'] },
            }),
            data: expect.objectContaining({ exceptionStatus: 'action_required' }),
          }),
        );
      } else {
        expect(purchaseUpdateMany).not.toHaveBeenCalled();
      }
    },
  );

  it('preserves a partial-refund decision while the child-order state fingerprint is unchanged', async () => {
    const skuList = [
      {
        platformOrderItemId: 'sku-order-1',
        skuId: 'sku-1',
        title: '退款商品',
        quantity: 1,
        unitPrice: 10,
        afterSaleStatus: 12,
        refundStatus: 3,
      },
      {
        platformOrderItemId: 'sku-order-2',
        skuId: 'sku-2',
        title: '剩余商品',
        quantity: 1,
        unitPrice: 10,
      },
    ];
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          ['sku-order-1', 12, null, 3],
          ['sku-order-2', null, null, null],
        ]),
      )
      .digest('hex');
    const orderUpsert = vi.fn().mockResolvedValue({ id: 20n });
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
        }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn((callback) =>
        callback({
          order: {
            findUnique: vi.fn().mockResolvedValue({
              id: 20n,
              amount: 20,
              status: 'paid',
              partialRefundFingerprint: fingerprint,
              items: skuList.map((sku) => ({
                platformOrderItemId: sku.platformOrderItemId,
              })),
              purchaseOrders: [{ id: 30n }],
            }),
            upsert: orderUpsert,
          },
          orderItem: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        }),
      ),
    } as unknown as PrismaService;
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      {
        create: vi.fn().mockReturnValue({
          listOrders: vi.fn().mockResolvedValue([
            {
              platformOrderId: 'order-1',
              buyerNick: '',
              receiverName: '',
              receiverPhone: '',
              receiverAddress: '',
              amount: 20,
              status: 'paid',
              paidAt: new Date(),
              skuList,
            },
          ]),
        }),
      } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await service.sync(USER, '9');

    expect(orderUpsert.mock.calls[0]![0].update).toMatchObject({
      afterSaleStatus: 'partial_refund',
      partialRefundFingerprint: fingerprint,
    });
    expect(orderUpsert.mock.calls[0]![0].update).not.toHaveProperty('partialRefundDisposition');
    expect(orderUpsert.mock.calls[0]![0].update).not.toHaveProperty('refundAmount');
  });

  it('paginates through the complete fixed order-update window', async () => {
    const orderUpsert = vi.fn().mockResolvedValue({ id: 20n });
    const shopUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
          lastOrderSyncAt: new Date('2026-07-18T10:00:00.000Z'),
        }),
        update: shopUpdate,
        updateMany: shopUpdate,
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(null), upsert: orderUpsert },
          orderItem: {
            upsert: vi.fn().mockResolvedValue({}),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        }),
      ),
    } as unknown as PrismaService;
    const page = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        platformOrderId: `order-${start + index}`,
        buyerNick: '',
        receiverName: '',
        receiverPhone: '',
        receiverAddress: '',
        amount: 10,
        status: 'paid',
        paidAt: new Date('2026-07-18T10:00:00.000Z'),
        skuList: [],
      }));
    const listOrders = vi
      .fn()
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 1));
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ listOrders }) } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    const result = await service.sync(USER, '9');

    expect(listOrders).toHaveBeenCalledTimes(2);
    const firstQuery = listOrders.mock.calls[0]![1];
    expect(firstQuery).toMatchObject({ cursor: '0', pageSize: 100 });
    expect(firstQuery.startTime).toEqual(new Date('2026-07-18T09:55:00.000Z'));
    expect(firstQuery.endTime).toBeInstanceOf(Date);
    expect(listOrders.mock.calls[1]![1]).toEqual({ ...firstQuery, cursor: '1' });
    expect(result).toEqual({ shopId: '9', synced: 101, skipped: 0 });
    expect(shopUpdate).toHaveBeenLastCalledWith({
      where: { id: 9n, status: 'active', orderSyncAttemptAt: firstQuery.endTime },
      data: {
        lastOrderSyncAt: firstQuery.endTime,
        orderSyncAttemptAt: firstQuery.endTime,
        orderSyncError: null,
      },
    });
  });

  it('stops before database writes when the distributed lock is lost during a platform page', async () => {
    const shopUpdate = vi.fn().mockResolvedValue({});
    const shopUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const transaction = vi.fn();
    const publishedProductFindMany = vi.fn();
    const redisEval = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const redisClient = {
      set: vi.fn().mockResolvedValue('OK'),
      eval: redisEval,
    } as unknown as Redis;
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
          lastOrderSyncAt: null,
        }),
        update: shopUpdate,
        updateMany: shopUpdateMany,
      },
      publishedProduct: { findMany: publishedProductFindMany },
      $transaction: transaction,
    } as unknown as PrismaService;
    const listOrders = vi.fn().mockResolvedValue([
      {
        platformOrderId: 'order-1',
        buyerNick: '',
        receiverName: '',
        receiverPhone: '',
        receiverAddress: '',
        amount: 10,
        status: 'paid',
        paidAt: new Date(),
        skuList: [],
      },
    ]);
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ listOrders }) } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redisClient,
    );

    await expect(service.sync(USER, '9')).rejects.toThrow('订单同步执行权已失效');

    expect(listOrders).toHaveBeenCalledTimes(1);
    expect(publishedProductFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(shopUpdateMany).toHaveBeenCalledWith({
      where: { id: 9n, orderSyncAttemptAt: expect.any(Date) },
      data: expect.objectContaining({ orderSyncError: expect.stringContaining('执行权已失效') }),
    });
    expect(redisEval).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pexpire'),
      1,
      'orders:sync:9',
      expect.any(String),
      '900000',
    );
  });

  it('fails without advancing the watermark when the configured page limit is exhausted', async () => {
    const shopUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
          lastOrderSyncAt: null,
        }),
        update: shopUpdate,
        updateMany: shopUpdate,
      },
      publishedProduct: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(),
    } as unknown as PrismaService;
    const listOrders = vi.fn().mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        platformOrderId: `order-${index}`,
        buyerNick: '',
        receiverName: '',
        receiverPhone: '',
        receiverAddress: '',
        amount: 0,
        status: 'paid',
        paidAt: new Date(),
        skuList: [],
      })),
    );
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ listOrders }) } as unknown as PlatformAdapterFactory,
      runtimeConfig({ DOUYIN_ORDER_SYNC_MAX_PAGES: 1 }),
      redis(),
    );

    await expect(service.sync(USER, '9')).rejects.toThrow('订单同步超过 1 页安全上限');

    expect(shopUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastOrderSyncAt: expect.any(Date) }),
      }),
    );
    expect(shopUpdate).toHaveBeenLastCalledWith({
      where: { id: 9n, orderSyncAttemptAt: expect.any(Date) },
      data: expect.objectContaining({
        orderSyncAttemptAt: expect.any(Date),
        orderSyncError: expect.stringContaining('未推进同步水位'),
      }),
    });
  });

  it('fails before writes or watermark advancement for an unsupported platform status', async () => {
    const shopUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const publishedProductFindMany = vi.fn();
    const transaction = vi.fn();
    const prisma = {
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 9n,
          userId: 1n,
          platform: 'douyin',
          platformShopId: '4463798',
          accessTokenEnc: 'encrypted-token',
          status: 'active',
          lastOrderSyncAt: null,
        }),
        update: shopUpdate,
        updateMany: shopUpdate,
      },
      publishedProduct: { findMany: publishedProductFindMany },
      $transaction: transaction,
    } as unknown as PrismaService;
    const listOrders = vi.fn().mockResolvedValue([
      {
        platformOrderId: 'order-1',
        buyerNick: '',
        receiverName: '',
        receiverPhone: '',
        receiverAddress: '',
        amount: 10,
        status: 'unknown',
        paidAt: new Date(),
        skuList: [],
      },
    ]);
    const service = new OrderSyncService(
      prisma,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn().mockResolvedValue('plain-token') } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ listOrders }) } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(),
    );

    await expect(service.sync(USER, '9')).rejects.toThrow(
      '平台返回未支持的订单状态，已停止更新并保留原状态',
    );

    expect(publishedProductFindMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(shopUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastOrderSyncAt: expect.any(Date) }),
      }),
    );
    expect(shopUpdate).toHaveBeenLastCalledWith({
      where: { id: 9n, orderSyncAttemptAt: expect.any(Date) },
      data: expect.objectContaining({
        orderSyncAttemptAt: expect.any(Date),
        orderSyncError: '平台返回未支持的订单状态，已停止更新并保留原状态',
      }),
    });
  });

  it('rejects concurrent synchronization before calling the platform', async () => {
    const shopUpdate = vi.fn();
    const listOrders = vi.fn();
    const service = new OrderSyncService(
      {
        shop: {
          findFirst: vi.fn().mockResolvedValue({
            id: 9n,
            userId: 1n,
            platform: 'douyin',
            platformShopId: '4463798',
            accessTokenEnc: 'encrypted-token',
            status: 'active',
            lastOrderSyncAt: null,
          }),
          update: shopUpdate,
        },
      } as unknown as PrismaService,
      new CryptoService({ get: () => 'unit-key' } as unknown as ConfigService),
      { getAccessToken: vi.fn() } as unknown as ShopTokenService,
      { create: vi.fn().mockReturnValue({ listOrders }) } as unknown as PlatformAdapterFactory,
      runtimeConfig(),
      redis(null),
    );

    await expect(service.sync(USER, '9')).rejects.toThrow('该店铺订单正在同步');
    expect(shopUpdate).not.toHaveBeenCalled();
    expect(listOrders).not.toHaveBeenCalled();
  });
});
