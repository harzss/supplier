import type { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto.module';
import type { PrismaService } from '../../common/prisma.module';
import type { CurrentUser } from '../entitlement/user-context.service';
import { OAuthConfigService } from '../shop/oauth-config.service';
import type { ShopTokenService } from '../shop/shop-token.service';
import { Alibaba1688PurchaseService } from './alibaba1688-purchase.service';

const USER: CurrentUser = { userId: 1n, plan: 'pro' };
const CALLBACK = 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback';

function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as ConfigService;
}

function enabledConfig(): ConfigService {
  return config({
    ALIBABA_1688_APP_KEY: '1000000',
    ALIBABA_1688_APP_SECRET: 'test123',
    ALIBABA_1688_OAUTH_REDIRECT_URI: CALLBACK,
    ALIBABA_1688_PAYMENT_MODE: 'manual',
    ALIBABA_1688_PURCHASE_ENABLED: 'true',
    OAUTH_CALLBACK_ALLOWLIST: CALLBACK,
  });
}

function orderItem(id: bigint, supplier: string, offerId: string, platformItemId: string) {
  return {
    id,
    sourceSupplierId: supplier,
    sourceOfferId: offerId,
    sourceSpecId: `spec-${id}`,
    sourceSpecRequired: true,
    sourceBindingId: null,
    sourceUnitCost: null,
    sourceOnePieceDrop: null,
    quantity: 1,
    platformOrderItemId: platformItemId,
    afterSaleStatusRaw: null,
    afterSaleTypeRaw: null,
    refundStatusRaw: null,
    purchaseOrderItem: null,
    publishedProduct: {
      costPrice: 8.5,
      sourceProduct: { isOnePieceDrop: true },
    },
  };
}

function buyerOrderResponse(status: string): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: {
        baseInfo: { idOfStr: '900001', status, totalAmount: 8.5 },
        productItems: [
          {
            productID: '111111',
            specId: 'spec-11',
            subItemIDString: 'entry-1',
            quantity: 1,
            status,
          },
        ],
      },
    }),
    { status: 200 },
  );
}

function logisticsResponse(trackingNo: string): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: [
        {
          logisticsId: trackingNo,
          orderEntryIds: 'entry-1',
          company: { name: '顺丰速运' },
          status: 'ACCEPT',
        },
      ],
    }),
    { status: 200 },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Alibaba1688PurchaseService', () => {
  it('fails closed unless the real-purchase switch is explicitly enabled', async () => {
    const values = config({ ALIBABA_1688_PAYMENT_MODE: 'manual' });
    const service = new Alibaba1688PurchaseService(
      {} as PrismaService,
      new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' })),
      values,
      new OAuthConfigService(values),
      {} as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('splits a paid sales order by supplier and creates idempotent saleproxy orders', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const items = [
      orderItem(11n, 'supplier-a', '111111', 'sku-order-1'),
      orderItem(12n, 'supplier-b', '222222', 'sku-order-2'),
    ];
    Object.assign(items[0]!, {
      // The FK may be cleared only after a historical binding is removed; frozen facts must remain authoritative.
      sourceBindingId: null,
      sourceUnitCost: 7.25,
      sourceOnePieceDrop: true,
      publishedProduct: {
        costPrice: 99,
        sourceProduct: { isOnePieceDrop: false },
      },
    });
    const purchaseOrderUpsert = vi.fn(async ({ create }) => ({
      ...create,
      id: create.supplierKey === 'supplier-a' ? 101n : 102n,
      retryCount: 0,
    }));
    const purchaseOrderItemUpsert = vi.fn().mockResolvedValue({});
    const purchaseOrderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const orderUpdate = vi.fn().mockResolvedValue({});
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const order = {
      id: 5n,
      status: 'paid',
      platformOrderId: 'douyin-order-5',
      receiverName: '张*',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt(
        JSON.stringify({
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          town: '仓前街道',
          detail: '文一西路 969 号',
        }),
      ),
      shop: { id: 9n },
      items,
      purchaseOrders: [],
    };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue(order),
        findUnique: vi.fn().mockResolvedValue({ status: 'paid' }),
        update: orderUpdate,
        updateMany: orderUpdateMany,
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { upsert: purchaseOrderUpsert, updateMany: purchaseOrderUpdateMany },
      purchaseOrderItem: { upsert: purchaseOrderItemUpsert },
      $transaction: vi.fn(async (callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(order) },
          purchaseOrder: { upsert: purchaseOrderUpsert },
          purchaseOrderItem: { upsert: purchaseOrderItemUpsert },
        }),
      ),
    } as unknown as PrismaService;
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body));
      const outOrderId = params.get('outOrderId')!;
      return new Response(
        JSON.stringify({
          success: true,
          result: { orderId: outOrderId.endsWith('supplier-a') ? '900001' : '900002' },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({
      packages: [],
      requestId: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('flow')).toBe('saleproxy');
      expect(body.get('fenxiaoChannel')).toBe('douyin');
      expect(body.get('outOrderId')).toMatch(/^supplier-5-supplier-[ab]$/);
    }
    expect(purchaseOrderItemUpsert).toHaveBeenCalledTimes(2);
    expect(purchaseOrderItemUpsert).toHaveBeenCalledWith({
      where: { orderItemId: 11n },
      create: expect.objectContaining({ orderItemId: 11n, unitCost: 7.25 }),
      update: expect.objectContaining({ unitCost: 7.25 }),
    });
    expect(purchaseOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: 101n, OR: [{ orderId1688: null }, { orderId1688: '900001' }] },
      data: expect.objectContaining({ orderId1688: '900001', status: 'awaiting_payment' }),
    });
    expect(purchaseOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: 102n, OR: [{ orderId1688: null }, { orderId1688: '900002' }] },
      data: expect.objectContaining({ orderId1688: '900002', status: 'awaiting_payment' }),
    });
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 5n,
        status: 'paid',
        OR: [
          { afterSaleStatus: { in: ['none', 'failed'] } },
          {
            afterSaleStatus: 'partial_refund',
            partialRefundDisposition: 'continue_remaining',
          },
        ],
      },
      data: { status: 'purchasing' },
    });
  });

  it('creates the purchase snapshot from the order state reread inside the transaction', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const staleItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const currentItem = orderItem(11n, 'supplier-a', '222222', 'sku-order-1');
    const baseOrder = {
      id: 5n,
      status: 'paid',
      afterSaleStatus: 'none',
      partialRefundDisposition: 'none',
      platformOrderId: 'douyin-order-5',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt(
        JSON.stringify({
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          detail: '文一西路 969 号',
        }),
      ),
      shop: { id: 9n },
      purchaseOrders: [],
    };
    const currentOrder = { ...baseOrder, items: [currentItem] };
    const transactionOrderFindUnique = vi.fn().mockResolvedValue(currentOrder);
    const purchaseOrderItemUpsert = vi.fn().mockResolvedValue({});
    const conflict = Object.assign(new Error('transaction conflict'), { code: 'P2034' });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation((callback) =>
        callback({
          order: { findUnique: transactionOrderFindUnique },
          purchaseOrder: {
            upsert: vi.fn().mockResolvedValue({
              id: 101n,
              outOrderId: 'supplier-5-supplier-a',
              orderId1688: null,
              status: 'pending',
              retryCount: 0,
            }),
          },
          purchaseOrderItem: { upsert: purchaseOrderItemUpsert },
        }),
      );
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({ ...baseOrder, items: [staleItem] }),
        findUnique: vi.fn().mockResolvedValue({
          status: 'paid',
          afterSaleStatus: 'none',
          partialRefundDisposition: 'none',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      $transaction: transaction,
    } as unknown as PrismaService;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { orderId: '900001' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({ packages: [], requestId: null });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(transactionOrderFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5n } }),
    );
    expect(purchaseOrderItemUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ offerId: '222222' }),
      }),
    );
    const body = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(JSON.parse(body.get('cargoParamList') ?? '[]')).toEqual([
      { offerId: '222222', specId: 'spec-11', quantity: 1 },
    ]);
  });

  it('recovers the same 1688 order after remote creation succeeds but local persistence fails', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const item = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const baseOrder = {
      id: 5n,
      status: 'paid',
      platformOrderId: 'douyin-order-5',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt(
        JSON.stringify({
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          detail: '文一西路 969 号',
        }),
      ),
      shop: { id: 9n },
      items: [item],
    };
    const existingPurchase = {
      id: 101n,
      supplierKey: 'supplier-a',
      outOrderId: 'supplier-5-supplier-a',
      orderId1688: null,
      status: 'failed',
      retryCount: 1,
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: item,
        },
      ],
      shipments: [],
    };
    const retryPurchase = { ...existingPurchase, retryCount: 2 };
    const transactionOrderFindUnique = vi
      .fn()
      .mockResolvedValueOnce({ ...baseOrder, purchaseOrders: [] })
      .mockResolvedValueOnce({ ...baseOrder, purchaseOrders: [existingPurchase] })
      .mockResolvedValueOnce({ ...baseOrder, purchaseOrders: [retryPurchase] });
    const purchaseOrderUpsert = vi
      .fn()
      .mockResolvedValueOnce({
        id: 101n,
        outOrderId: 'supplier-5-supplier-a',
        orderId1688: null,
        status: 'pending',
        retryCount: 0,
      })
      .mockResolvedValueOnce(existingPurchase)
      .mockResolvedValueOnce(retryPurchase);
    let resultPersistenceAttempts = 0;
    const purchaseOrderUpdateMany = vi.fn(async ({ data }) => {
      if (data.orderId1688) {
        resultPersistenceAttempts += 1;
        if (resultPersistenceAttempts === 1) throw new Error('db unavailable');
      }
      return { count: 1 };
    });
    const prisma = {
      order: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ ...baseOrder, purchaseOrders: [] })
          .mockResolvedValueOnce({ ...baseOrder, purchaseOrders: [existingPurchase] })
          .mockResolvedValueOnce({ ...baseOrder, purchaseOrders: [retryPurchase] }),
        findUnique: vi.fn().mockResolvedValue({ status: 'paid' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { updateMany: purchaseOrderUpdateMany },
      $transaction: vi.fn((callback) =>
        callback({
          order: { findUnique: transactionOrderFindUnique },
          purchaseOrder: { upsert: purchaseOrderUpsert },
          purchaseOrderItem: { upsert: vi.fn().mockResolvedValue({}) },
        }),
      ),
    } as unknown as PrismaService;
    let recoveryQueries = 0;
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).includes('alibaba.trade.getBuyerOrderList')) {
        recoveryQueries += 1;
        return new Response(
          JSON.stringify({
            totalRecord: 1,
            result: [
              {
                baseInfo: { idOfStr: '900001', status: 'waitbuyerpay' },
                productItems: [
                  {
                    productID: recoveryQueries === 2 ? '222222' : '111111',
                    subItemIDString: '900001-1',
                    specId: 'spec-11',
                    quantity: 1,
                    status: 'waitbuyerpay',
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('', { status: 504 });
    });
    vi.stubGlobal('fetch', fetcher);
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).rejects.toThrow('db unavailable');
    await expect(service.advance(USER, 5n)).rejects.toThrow(
      '1688 恢复采购单商品明细与本地快照不一致',
    );
    await expect(service.advance(USER, 5n)).resolves.toEqual({ packages: [], requestId: null });

    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('alibaba.trade.fastCreateOrder')),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('alibaba.trade.getBuyerOrderList')),
    ).toHaveLength(3);
    expect(purchaseOrderUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 101n, OR: [{ orderId1688: null }, { orderId1688: '900001' }] },
      data: {
        orderId1688: '900001',
        status: 'awaiting_payment',
        failureReason: null,
      },
    });
  });

  it('creates purchases only for non-refunded items after an explicit continuation decision', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const refundedItem = {
      ...orderItem(11n, 'supplier-a', '111111', 'sku-order-1'),
      afterSaleStatusRaw: 12,
      refundStatusRaw: 3,
    };
    const remainingItem = orderItem(12n, 'supplier-b', '222222', 'sku-order-2');
    const purchaseOrderItemUpsert = vi.fn().mockResolvedValue({});
    const purchaseOrderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const orderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const order = {
      id: 5n,
      status: 'paid',
      afterSaleStatus: 'partial_refund',
      partialRefundDisposition: 'continue_remaining',
      platformOrderId: 'douyin-order-5',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt(
        JSON.stringify({
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          detail: '文一西路 969 号',
        }),
      ),
      shop: { id: 9n },
      items: [refundedItem, remainingItem],
      purchaseOrders: [],
    };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue(order),
        findUnique: vi.fn().mockResolvedValue({
          status: 'paid',
          afterSaleStatus: 'partial_refund',
          partialRefundDisposition: 'continue_remaining',
        }),
        updateMany: orderUpdateMany,
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { updateMany: purchaseOrderUpdateMany },
      $transaction: vi.fn((callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(order) },
          purchaseOrder: {
            upsert: vi.fn().mockResolvedValue({
              id: 102n,
              outOrderId: 'supplier-5-supplier-b',
              retryCount: 0,
            }),
          },
          purchaseOrderItem: { upsert: purchaseOrderItemUpsert },
        }),
      ),
    } as unknown as PrismaService;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { orderId: '900002' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({
      packages: [],
      requestId: null,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body));
    expect(JSON.parse(body.get('cargoParamList')!)).toEqual([
      expect.objectContaining({ offerId: '222222', specId: 'spec-12', quantity: 1 }),
    ]);
    expect(purchaseOrderItemUpsert).toHaveBeenCalledTimes(1);
    expect(purchaseOrderItemUpsert.mock.calls[0]![0].where.orderItemId).toBe(12n);
    expect(purchaseOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: 102n, OR: [{ orderId1688: null }, { orderId1688: '900002' }] },
      data: expect.objectContaining({ orderId1688: '900002' }),
    });
  });

  it('uses the replacement external order ID for a retried purchase', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const item = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchase = {
      id: 101n,
      supplierKey: 'supplier-a',
      outOrderId: 'supplier-5-supplier-a-r2',
      orderId1688: null,
      status: 'pending',
      retryCount: 0,
      exceptionStatus: 'none',
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: item,
        },
      ],
      shipments: [],
    };
    const purchaseOrderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const order = {
      id: 5n,
      status: 'paid',
      afterSaleStatus: 'none',
      partialRefundDisposition: 'none',
      platformOrderId: 'douyin-order-5',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt(
        JSON.stringify({
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          detail: '文一西路 969 号',
        }),
      ),
      shop: { id: 9n },
      items: [item],
      purchaseOrders: [purchase],
    };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue(order),
        findUnique: vi.fn().mockResolvedValue({ status: 'paid' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { updateMany: purchaseOrderUpdateMany },
      $transaction: vi.fn((callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(order) },
          purchaseOrder: { upsert: vi.fn().mockResolvedValue(purchase) },
          purchaseOrderItem: { upsert: vi.fn().mockResolvedValue({}) },
        }),
      ),
    } as unknown as PrismaService;
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { orderId: '900002' } }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({
      packages: [],
      requestId: null,
    });

    const body = new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.get('outOrderId')).toBe('supplier-5-supplier-a-r2');
    expect(purchaseOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: 101n, OR: [{ orderId1688: null }, { orderId1688: '900002' }] },
      data: expect.objectContaining({ orderId1688: '900002', status: 'awaiting_payment' }),
    });
  });

  it('marks a created purchase for manual action when the sales order is refunded concurrently', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const item = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchaseExceptionUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const purchaseOrderUpdateMany = vi.fn(async (args) =>
      args.data.orderId1688 ? { count: 1 } : purchaseExceptionUpdateMany(args),
    );
    const order = {
      id: 5n,
      status: 'paid',
      platformOrderId: 'douyin-order-5',
      receiverName: '张*',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt(
        JSON.stringify({
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          detail: '文一西路 969 号',
        }),
      ),
      shop: { id: 9n },
      items: [item],
      purchaseOrders: [],
    };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue(order),
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ status: 'paid' })
          .mockResolvedValueOnce({ status: 'refunded' }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: {
        upsert: vi.fn().mockResolvedValue({
          id: 101n,
          outOrderId: 'supplier-5-supplier-a',
          retryCount: 0,
        }),
        updateMany: purchaseOrderUpdateMany,
      },
      purchaseOrderItem: { upsert: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (callback) =>
        callback({
          order: { findUnique: vi.fn().mockResolvedValue(order) },
          purchaseOrder: {
            upsert: vi.fn().mockResolvedValue({
              id: 101n,
              outOrderId: 'supplier-5-supplier-a',
              retryCount: 0,
            }),
          },
          purchaseOrderItem: { upsert: vi.fn().mockResolvedValue({}) },
        }),
      ),
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { orderId: '900001' } }), {
          status: 200,
        }),
      ),
    );
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({ packages: [], requestId: null });

    expect(purchaseOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: 101n, OR: [{ orderId1688: null }, { orderId1688: '900001' }] },
      data: expect.objectContaining({ orderId1688: '900001', status: 'awaiting_payment' }),
    });
    expect(purchaseExceptionUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orderId: 5n,
          exceptionStatus: { in: ['none', 'resolved', 'action_required'] },
        }),
        data: expect.objectContaining({ exceptionStatus: 'action_required', reconciledCost: null }),
      }),
    );
  });

  it.each([
    [
      'a different remote order ID',
      '900999',
      '111111',
      '1688 采购单详情与本地绑定不一致，已停止自动处理',
    ],
    [
      'changed remote product items',
      '900001',
      '222222',
      '1688 采购单商品明细与本地快照不一致，已停止自动处理',
    ],
  ])(
    'persists a typed snapshot exception before rejecting %s',
    async (_label, remoteOrderId, offerId, error) => {
      const values = enabledConfig();
      const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
      const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
      const purchaseClaim = vi
        .fn()
        .mockResolvedValue({ syncRevision: 1, status: 'awaiting_payment' });
      const purchaseUpdateMany = vi.fn();
      const transaction = vi.fn();
      const prisma = {
        order: {
          findFirst: vi.fn().mockResolvedValue({
            id: 5n,
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
            platformOrderId: 'douyin-order-5',
            shop: { id: 9n },
            items: [localItem],
            purchaseOrders: [
              {
                id: 101n,
                orderId1688: '900001',
                supplierKey: 'supplier-a',
                status: 'awaiting_payment',
                purchaseCost: 8.5,
                items: [
                  {
                    orderItemId: 11n,
                    offerId: '111111',
                    specId: 'spec-11',
                    quantity: 1,
                    orderItem: localItem,
                  },
                ],
                shipments: [],
              },
            ],
          }),
        },
        shop: {
          findFirst: vi.fn().mockResolvedValue({
            id: 20n,
            userId: 1n,
            platformShopId: 'buyer-1',
          }),
        },
        purchaseOrder: { update: purchaseClaim, updateMany: purchaseUpdateMany },
        $transaction: transaction,
      } as unknown as PrismaService;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              success: true,
              result: {
                baseInfo: {
                  idOfStr: remoteOrderId,
                  status: 'waitsellersend',
                  totalAmount: 8.5,
                },
                productItems: [
                  {
                    productID: offerId,
                    specId: offerId === '111111' ? 'spec-11' : 'spec-12',
                    subItemIDString: 'entry-1',
                    quantity: 1,
                    status: 'waitsellersend',
                  },
                ],
              },
            }),
            { status: 200 },
          ),
        ),
      );
      const service = new Alibaba1688PurchaseService(
        prisma,
        crypto,
        values,
        new OAuthConfigService(values),
        { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
      );

      await expect(service.advance(USER, 5n)).rejects.toThrow(error);

      expect(purchaseClaim).toHaveBeenCalledWith({
        where: { id: 101n },
        data: { syncRevision: { increment: 1 } },
        select: { syncRevision: true, status: true },
      });
      expect(purchaseUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 101n,
          syncRevision: 1,
          exceptionStatus: { in: ['none', 'resolved'] },
        },
        data: expect.objectContaining({
          exceptionStatus: 'action_required',
          exceptionRevision: { increment: 1 },
          exceptionCode: 'purchase_snapshot_mismatch',
          exceptionReason: error,
        }),
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['received', 'waitbuyerreceive', '1688 采购单状态发生回退，已停止自动处理'],
    ['failed', 'waitsellersend', '1688 采购单终态不能自动恢复，已停止自动处理'],
  ])(
    'rejects a remote status that would move local %s backward',
    async (currentStatus, remoteStatus, error) => {
      const values = enabledConfig();
      const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
      const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
      const purchaseClaim = vi.fn().mockResolvedValue({
        syncRevision: 1,
        status: currentStatus,
      });
      const purchaseUpdateMany = vi.fn();
      const transaction = vi.fn();
      const prisma = {
        order: {
          findFirst: vi.fn().mockResolvedValue({
            id: 5n,
            status: 'purchasing',
            afterSaleStatus: 'none',
            partialRefundDisposition: 'none',
            platformOrderId: 'douyin-order-5',
            shop: { id: 9n },
            items: [localItem],
            purchaseOrders: [
              {
                id: 101n,
                orderId1688: '900001',
                supplierKey: 'supplier-a',
                status: currentStatus,
                purchaseCost: 8.5,
                items: [
                  {
                    orderItemId: 11n,
                    offerId: '111111',
                    specId: 'spec-11',
                    quantity: 1,
                    orderItem: localItem,
                  },
                ],
                shipments: [],
              },
            ],
          }),
        },
        shop: {
          findFirst: vi.fn().mockResolvedValue({
            id: 20n,
            userId: 1n,
            platformShopId: 'buyer-1',
          }),
        },
        purchaseOrder: { update: purchaseClaim, updateMany: purchaseUpdateMany },
        $transaction: transaction,
      } as unknown as PrismaService;
      const fetcher = vi.fn().mockResolvedValue(buyerOrderResponse(remoteStatus));
      vi.stubGlobal('fetch', fetcher);
      const service = new Alibaba1688PurchaseService(
        prisma,
        crypto,
        values,
        new OAuthConfigService(values),
        { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
      );

      await expect(service.advance(USER, 5n)).rejects.toThrow(error);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(purchaseUpdateMany).toHaveBeenCalledWith({
        where: {
          id: 101n,
          syncRevision: 1,
          exceptionStatus: { in: ['none', 'resolved'] },
        },
        data: expect.objectContaining({
          exceptionStatus: 'action_required',
          exceptionCode: 'purchase_snapshot_mismatch',
          exceptionReason: error,
        }),
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('opens a retryable work item when 1688 cancels an unshipped purchase', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchase = {
      id: 101n,
      orderId1688: '900001',
      supplierKey: 'supplier-a',
      status: 'awaiting_payment',
      purchaseCost: 8.5,
      everShipped: false,
      exceptionStatus: 'none',
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: localItem,
        },
      ],
      shipments: [],
    };
    const order = {
      id: 5n,
      status: 'purchasing',
      afterSaleStatus: 'none',
      partialRefundDisposition: 'none',
      platformOrderId: 'douyin-order-5',
      shop: { id: 9n },
      items: [localItem],
      purchaseOrders: [purchase],
    };
    const purchaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(order) },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: {
        update: vi.fn().mockResolvedValue({ syncRevision: 1, status: 'awaiting_payment' }),
        updateMany: purchaseUpdateMany,
      },
    } as unknown as PrismaService;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(buyerOrderResponse('cancel')));
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({
      packages: [],
      requestId: null,
    });

    expect(purchaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 101n, syncRevision: 1 },
      data: expect.objectContaining({
        status: 'failed',
        purchaseCost: 8.5,
        retryEligible: true,
        exceptionStatus: 'action_required',
        exceptionRevision: { increment: 1 },
        exceptionCode: 'purchase_remote_cancelled_retryable',
        reconciledCost: null,
      }),
    });
  });

  it('opens a logistics-recovery work item when a previously shipped purchase is closed', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchase = {
      id: 101n,
      orderId1688: '900001',
      supplierKey: 'supplier-a',
      status: 'shipped',
      purchaseCost: 8.5,
      everShipped: true,
      exceptionStatus: 'none',
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: localItem,
        },
      ],
      shipments: [
        {
          id: 201n,
          trackingNo: 'OLD111',
          carrier: '顺丰速运',
          status: 'ACCEPT',
          items: [{ orderItemId: 11n, quantity: 1, orderItem: localItem }],
        },
      ],
    };
    const order = {
      id: 5n,
      status: 'purchasing',
      afterSaleStatus: 'none',
      partialRefundDisposition: 'none',
      platformOrderId: 'douyin-order-5',
      shop: { id: 9n },
      items: [localItem],
      purchaseOrders: [purchase],
    };
    const purchaseUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      order: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(order)
          .mockResolvedValueOnce({
            ...order,
            purchaseOrders: [
              {
                ...purchase,
                status: 'failed',
                exceptionStatus: 'action_required',
              },
            ],
          }),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: {
        update: vi.fn().mockResolvedValue({ syncRevision: 2, status: 'shipped' }),
        updateMany: purchaseUpdateMany,
      },
    } as unknown as PrismaService;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(buyerOrderResponse('closed')));
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).resolves.toEqual({
      packages: [],
      requestId: null,
    });

    expect(purchaseUpdateMany).toHaveBeenCalledWith({
      where: { id: 101n, syncRevision: 2 },
      data: expect.objectContaining({
        status: 'failed',
        retryEligible: false,
        exceptionStatus: 'action_required',
        exceptionRevision: { increment: 1 },
      }),
    });
  });

  it('preserves the original snapshot when settled-order logistics routing changes', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const flagUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (operation: (tx: PrismaService) => Promise<unknown>) =>
      operation(prisma),
    );
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          id: 101n,
          orderId: 5n,
          buyerShopId: 20n,
          orderId1688: '900001',
          status: 'shipped',
          syncRevision: 2,
          purchaseCost: 8.5,
          everShipped: true,
          exceptionStatus: 'none',
          items: [
            {
              orderItemId: 11n,
              offerId: '111111',
              specId: 'spec-11',
              quantity: 1,
              orderItem: localItem,
            },
          ],
          shipments: [
            {
              id: 201n,
              trackingNo: 'OLD111',
              carrier: '顺丰速运',
              status: 'ACCEPT',
              items: [{ orderItemId: 11n, quantity: 1, orderItem: localItem }],
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({ syncRevision: 3, status: 'shipped' }),
        updateMany: flagUpdate,
        findUnique: vi.fn().mockResolvedValue({ exceptionStatus: 'action_required' }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.includes('alibaba.trade.get.buyerView')) {
          return buyerOrderResponse('waitbuyerreceive');
        }
        return logisticsResponse('NEW222');
      }),
    );
    const materializeOrder = vi.fn().mockResolvedValue(undefined);
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
      { materializeOrder } as never,
    );

    await expect(service.auditSettledPurchase(1n, 101n)).resolves.toBe('action_required');

    expect(flagUpdate).toHaveBeenNthCalledWith(2, {
      where: {
        id: 101n,
        syncRevision: 3,
        exceptionStatus: { in: ['none', 'resolved'] },
        status: { in: ['shipped', 'received'] },
        order: { status: { in: ['shipped', 'received'] } },
      },
      data: expect.objectContaining({
        retryEligible: false,
        exceptionStatus: 'action_required',
        exceptionRevision: { increment: 1 },
        reconciledCost: null,
      }),
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(materializeOrder).toHaveBeenCalledTimes(2);
    expect(materializeOrder).toHaveBeenLastCalledWith(prisma, 5n);
  });

  it('builds an immutable settled-logistics repair proposal from verified remote data', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchase = {
      id: 101n,
      buyerShopId: 20n,
      orderId1688: '900001',
      status: 'shipped',
      syncRevision: 3,
      purchaseCost: 8.5,
      priorIncurredCost: 0,
      everShipped: true,
      retryEligible: false,
      exceptionStatus: 'action_required',
      exceptionRevision: 4,
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: localItem,
        },
      ],
      shipments: [
        {
          id: 201n,
          trackingNo: 'OLD111',
          carrier: '顺丰速运',
          status: 'ACCEPT',
          items: [{ orderItemId: 11n, quantity: 1, orderItem: localItem }],
        },
      ],
    };
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'shipped',
          afterSaleStatus: 'none',
          partialRefundDisposition: 'none',
          platformOrderId: 'douyin-order-5',
          shop: { id: 9n },
          items: [localItem],
          purchaseOrders: [purchase],
        }),
      },
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return path.includes('alibaba.trade.get.buyerView')
          ? buyerOrderResponse('waitbuyerreceive')
          : logisticsResponse('NEW222');
      }),
    );
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.prepareSettledLogisticsRepair(1n, 5n, 101n, 4)).resolves.toEqual({
      purchaseOrderId: 101n,
      purchaseSyncRevision: 3,
      priorIncurredCost: 0,
      targetPurchaseStatus: 'shipped',
      targetPurchaseCost: 8.5,
      previousPlatformPackages: [
        {
          trackingNo: 'OLD111',
          carrier: '顺丰速运',
          items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
        },
      ],
      targetPlatformPackages: [
        {
          trackingNo: 'NEW222',
          carrier: '顺丰速运',
          items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
        },
      ],
      targetPurchaseShipments: [
        {
          trackingNo: 'NEW222',
          carrier: '顺丰速运',
          status: 'ACCEPT',
          items: [{ orderItemId: '11', quantity: 1 }],
        },
      ],
      targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('turns a settled remote item mismatch into an action-required work item', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          id: 101n,
          buyerShopId: 20n,
          orderId1688: '900001',
          status: 'shipped',
          syncRevision: 1,
          purchaseCost: 8.5,
          everShipped: true,
          exceptionStatus: 'none',
          items: [
            {
              orderItemId: 11n,
              offerId: '111111',
              specId: 'spec-11',
              quantity: 1,
              orderItem: localItem,
            },
          ],
          shipments: [
            {
              id: 201n,
              trackingNo: 'OLD111',
              carrier: '顺丰速运',
              status: 'ACCEPT',
              items: [{ orderItemId: 11n, quantity: 1, orderItem: localItem }],
            },
          ],
        }),
        updateMany,
        findUnique: vi.fn().mockResolvedValue({ exceptionStatus: 'action_required' }),
      },
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: {
              baseInfo: { idOfStr: '900001', status: 'waitbuyerreceive', totalAmount: 8.5 },
              productItems: [
                {
                  productID: '222222',
                  specId: 'spec-11',
                  subItemIDString: 'entry-1',
                  quantity: 1,
                  status: 'waitbuyerreceive',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.auditSettledPurchase(1n, 101n)).resolves.toBe('action_required');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          exceptionStatus: 'action_required',
          exceptionRevision: { increment: 1 },
        }),
      }),
    );
  });

  it('updates a healthy settled shipment without rewriting its cost', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const claim = vi.fn().mockResolvedValue({ count: 1 });
    const purchaseWrite = vi.fn().mockResolvedValue({ count: 1 });
    const shipmentUpsert = vi.fn().mockResolvedValue({ id: 201n });
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) =>
      callback({
        purchaseOrder: { updateMany: purchaseWrite },
        purchaseShipment: { deleteMany: vi.fn(), upsert: shipmentUpsert },
        purchaseShipmentItem: { deleteMany: vi.fn(), createMany: vi.fn() },
      }),
    );
    const prisma = {
      purchaseOrder: {
        findFirst: vi.fn().mockResolvedValue({
          id: 101n,
          buyerShopId: 20n,
          orderId1688: '900001',
          status: 'shipped',
          syncRevision: 5,
          purchaseCost: 8.5,
          everShipped: true,
          exceptionStatus: 'none',
          items: [
            {
              orderItemId: 11n,
              offerId: '111111',
              specId: 'spec-11',
              quantity: 1,
              orderItem: localItem,
            },
          ],
          shipments: [
            {
              id: 201n,
              trackingNo: 'SF111',
              carrier: '顺丰速运',
              status: 'ACCEPT',
              items: [{ orderItemId: 11n, quantity: 1, orderItem: localItem }],
            },
          ],
        }),
        updateMany: claim,
        findUnique: vi.fn().mockResolvedValue({ exceptionStatus: 'none' }),
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        return path.includes('alibaba.trade.get.buyerView')
          ? buyerOrderResponse('success')
          : logisticsResponse('SF111');
      }),
    );
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.auditSettledPurchase(1n, 101n)).resolves.toBe('checked');

    expect(purchaseWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ purchaseCost: expect.anything() }),
      }),
    );
    expect(shipmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ status: 'ACCEPT' }) }),
    );
  });

  it('rejects duplicate remote tracking numbers before any purchase or shipment write', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchaseClaim = vi
      .fn()
      .mockResolvedValue({ syncRevision: 1, status: 'awaiting_payment' });
    const purchaseUpdateMany = vi.fn();
    const transaction = vi.fn();
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValue({
          id: 5n,
          status: 'purchasing',
          afterSaleStatus: 'none',
          partialRefundDisposition: 'none',
          platformOrderId: 'douyin-order-5',
          shop: { id: 9n },
          items: [localItem],
          purchaseOrders: [
            {
              id: 101n,
              orderId1688: '900001',
              supplierKey: 'supplier-a',
              status: 'awaiting_payment',
              purchaseCost: 8.5,
              items: [
                {
                  orderItemId: 11n,
                  offerId: '111111',
                  specId: 'spec-11',
                  quantity: 1,
                  orderItem: localItem,
                },
              ],
              shipments: [],
            },
          ],
        }),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { update: purchaseClaim, updateMany: purchaseUpdateMany },
      $transaction: transaction,
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.includes('alibaba.trade.get.buyerView')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                baseInfo: {
                  idOfStr: '900001',
                  status: 'waitbuyerreceive',
                  totalAmount: 8.5,
                },
                productItems: [
                  {
                    productID: '111111',
                    specId: 'spec-11',
                    subItemIDString: 'entry-1',
                    quantity: 1,
                    status: 'waitbuyerreceive',
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                logisticsId: 'SF111',
                orderEntryIds: 'entry-1',
                company: { name: '顺丰速运' },
              },
              {
                logisticsId: 'SF111',
                orderEntryIds: 'entry-1',
                company: { name: '顺丰速运' },
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).rejects.toThrow(
      'Alibaba 1688 logistics query returned an invalid response',
    );

    expect(purchaseClaim).toHaveBeenCalledTimes(1);
    expect(purchaseUpdateMany).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not let a late purchase poll overwrite a newer logistics snapshot', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const purchase = {
      id: 101n,
      orderId1688: '900001',
      supplierKey: 'supplier-a',
      status: 'awaiting_payment',
      purchaseCost: 8.5,
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: localItem,
        },
      ],
      shipments: [],
    };
    const order = {
      id: 5n,
      status: 'purchasing',
      afterSaleStatus: 'none',
      partialRefundDisposition: 'none',
      platformOrderId: 'douyin-order-5',
      shop: { id: 9n },
      items: [localItem],
      purchaseOrders: [purchase],
    };
    let releaseOlderPoll!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => {
      releaseOlderPoll = resolve;
    });
    let signalOlderPollStarted!: () => void;
    const olderPollStarted = new Promise<void>((resolve) => {
      signalOlderPollStarted = resolve;
    });
    let remoteCalls = 0;
    let logisticsCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.includes('alibaba.trade.get.buyerView')) {
          remoteCalls += 1;
          if (remoteCalls === 1) {
            signalOlderPollStarted();
            return olderResponse;
          }
          return buyerOrderResponse('success');
        }
        logisticsCalls += 1;
        return logisticsResponse(logisticsCalls === 1 ? 'NEW222' : 'OLD111');
      }),
    );

    let revision = 0;
    const purchaseClaim = vi.fn(async () => ({
      syncRevision: ++revision,
      status: 'awaiting_payment',
    }));
    const purchaseWrites: Array<Record<string, unknown>> = [];
    const shipmentUpsert = vi.fn(async ({ create }) => ({ ...create, id: 201n }));
    const transaction = vi.fn(async (callback) =>
      callback({
        purchaseOrder: {
          updateMany: vi.fn(async ({ where, data }) => {
            if (where.syncRevision !== revision) return { count: 0 };
            purchaseWrites.push(data);
            return { count: 1 };
          }),
        },
        purchaseShipment: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          upsert: shipmentUpsert,
        },
        purchaseShipmentItem: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      }),
    );
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(order) },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { update: purchaseClaim },
      $transaction: transaction,
    } as unknown as PrismaService;
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    const olderPoll = service.advance(USER, 5n);
    await olderPollStarted;
    await service.advance(USER, 5n);
    releaseOlderPoll(buyerOrderResponse('waitbuyerreceive'));
    await olderPoll;

    expect(purchaseClaim).toHaveBeenCalledTimes(2);
    expect(purchaseWrites).toEqual([
      expect.objectContaining({ status: 'received', trackingNo: 'NEW222' }),
    ]);
    expect(shipmentUpsert).toHaveBeenCalledTimes(1);
    expect(shipmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ trackingNo: 'NEW222' }) }),
    );
  });

  it('rejects a stored package that contains an item excluded from final fulfillment', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const eligibleItem = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const refundedItem = {
      ...orderItem(12n, 'supplier-a', '222222', 'sku-order-2'),
      afterSaleStatusRaw: 12,
      refundStatusRaw: 3,
    };
    const order = {
      id: 5n,
      status: 'purchasing',
      afterSaleStatus: 'partial_refund',
      partialRefundDisposition: 'continue_remaining',
      platformOrderId: 'douyin-order-5',
      shop: { id: 9n },
      items: [eligibleItem, refundedItem],
      purchaseOrders: [
        {
          id: 101n,
          orderId1688: null,
          supplierKey: 'supplier-a',
          status: 'shipped',
          purchaseCost: 8.5,
          items: [
            {
              orderItemId: 11n,
              offerId: '111111',
              specId: 'spec-11',
              quantity: 1,
              orderItem: eligibleItem,
            },
          ],
          shipments: [
            {
              id: 201n,
              trackingNo: 'SF111',
              carrier: '顺丰速运',
              items: [
                { orderItemId: 11n, quantity: 1, orderItem: eligibleItem },
                { orderItemId: 12n, quantity: 1, orderItem: refundedItem },
              ],
            },
          ],
        },
      ],
    };
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const prisma = {
      order: { findFirst: vi.fn().mockResolvedValue(order) },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
    } as unknown as PrismaService;
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    await expect(service.advance(USER, 5n)).rejects.toThrow(
      '1688 包裹包含不属于当前采购单的订单项',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps paid 1688 orders and logistics back to deterministic Douyin packages', async () => {
    const values = enabledConfig();
    const crypto = new CryptoService(config({ ENCRYPTION_KEY: 'unit-key' }));
    const localItem1 = orderItem(11n, 'supplier-a', '111111', 'sku-order-1');
    const localItem2 = orderItem(12n, 'supplier-b', '222222', 'sku-order-2');
    const refundedItem = {
      ...orderItem(13n, 'supplier-c', '333333', 'sku-order-3'),
      afterSaleStatusRaw: 12,
      refundStatusRaw: 3,
    };
    const purchase1 = {
      id: 101n,
      orderId1688: '900001',
      supplierKey: 'supplier-a',
      status: 'awaiting_payment',
      purchaseCost: null,
      items: [
        {
          orderItemId: 11n,
          offerId: '111111',
          specId: 'spec-11',
          quantity: 1,
          orderItem: localItem1,
        },
      ],
      shipments: [],
    };
    const purchase2 = {
      id: 102n,
      orderId1688: '900002',
      supplierKey: 'supplier-b',
      status: 'awaiting_payment',
      purchaseCost: null,
      items: [
        {
          orderItemId: 12n,
          offerId: '222222',
          specId: 'spec-12',
          quantity: 1,
          orderItem: localItem2,
        },
      ],
      shipments: [],
    };
    const baseOrder = {
      id: 5n,
      status: 'purchasing',
      afterSaleStatus: 'partial_refund',
      partialRefundDisposition: 'continue_remaining',
      platformOrderId: 'douyin-order-5',
      receiverName: '张*',
      receiverNameEnc: crypto.encrypt('张三'),
      receiverPhoneEnc: crypto.encrypt('13811112222'),
      receiverAddressDetailEnc: crypto.encrypt('{}'),
      shop: { id: 9n },
      items: [localItem1, localItem2, refundedItem],
      purchaseOrders: [purchase1, purchase2],
    };
    const completedOrder = {
      ...baseOrder,
      purchaseOrders: [
        {
          ...purchase1,
          status: 'shipped',
          shipments: [
            {
              id: 201n,
              trackingNo: 'SF111',
              carrier: '顺丰速运',
              items: [{ orderItemId: 11n, quantity: 1, orderItem: localItem1 }],
            },
          ],
        },
        {
          ...purchase2,
          status: 'shipped',
          shipments: [
            {
              id: 202n,
              trackingNo: 'YT222',
              carrier: '圆通速递',
              items: [{ orderItemId: 12n, quantity: 1, orderItem: localItem2 }],
            },
          ],
        },
      ],
    };
    const purchaseOrderClaim = vi
      .fn()
      .mockResolvedValue({ syncRevision: 1, status: 'awaiting_payment' });
    const purchaseOrderUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const purchaseShipmentDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const purchaseShipmentItemDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const purchaseShipmentItemCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = vi.fn(async (callback) =>
      callback({
        purchaseOrder: { updateMany: purchaseOrderUpdateMany },
        purchaseShipment: {
          deleteMany: purchaseShipmentDeleteMany,
          upsert: vi.fn(async ({ create }) => ({
            ...create,
            id: create.trackingNo === 'SF111' ? 201n : 202n,
          })),
        },
        purchaseShipmentItem: {
          deleteMany: purchaseShipmentItemDeleteMany,
          createMany: purchaseShipmentItemCreateMany,
        },
      }),
    );
    const prisma = {
      order: {
        findFirst: vi.fn().mockResolvedValueOnce(baseOrder).mockResolvedValueOnce(completedOrder),
      },
      shop: {
        findFirst: vi.fn().mockResolvedValue({
          id: 20n,
          userId: 1n,
          platformShopId: 'buyer-1',
        }),
      },
      purchaseOrder: { update: purchaseOrderClaim },
      purchaseShipment: {
        upsert: vi.fn(async ({ create }) => ({
          ...create,
          id: create.trackingNo === 'SF111' ? 201n : 202n,
        })),
      },
      purchaseShipmentItem: {
        deleteMany: purchaseShipmentItemDeleteMany,
        createMany: purchaseShipmentItemCreateMany,
      },
      $transaction: transaction,
    } as unknown as PrismaService;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const params = new URLSearchParams(String(init?.body));
        const orderId = params.get('orderId')!;
        const suffix = orderId === '900001' ? '1' : '2';
        if (path.includes('alibaba.trade.get.buyerView')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: {
                baseInfo: { idOfStr: orderId, status: 'waitbuyerreceive', totalAmount: 9.9 },
                productItems: [
                  {
                    productID: orderId === '900001' ? '111111' : '222222',
                    specId: orderId === '900001' ? 'spec-11' : 'spec-12',
                    subItemIDString: `entry-${suffix}`,
                    quantity: 1,
                    status: 'waitbuyerreceive',
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                logisticsId: orderId === '900001' ? 'SF111' : 'YT222',
                orderEntryIds: orderId === '900001' ? undefined : `entry-${suffix}`,
                company: { name: orderId === '900001' ? '顺丰速运' : '圆通速递' },
                status: 'ACCEPT',
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const service = new Alibaba1688PurchaseService(
      prisma,
      crypto,
      values,
      new OAuthConfigService(values),
      { getAccessToken: vi.fn().mockResolvedValue('buyer-token') } as unknown as ShopTokenService,
    );

    const result = await service.advance(USER, 5n);

    expect(result.packages).toEqual([
      {
        trackingNo: 'SF111',
        carrier: '顺丰速运',
        items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
      },
      {
        trackingNo: 'YT222',
        carrier: '圆通速递',
        items: [{ platformOrderItemId: 'sku-order-2', quantity: 1 }],
      },
    ]);
    expect(result.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(purchaseOrderClaim).toHaveBeenCalledTimes(2);
    expect(purchaseOrderUpdateMany).toHaveBeenCalledTimes(2);
    expect(purchaseShipmentDeleteMany).toHaveBeenCalledWith({
      where: { purchaseOrderId: 101n, trackingNo: { notIn: ['SF111'] } },
    });
    expect(purchaseShipmentDeleteMany).toHaveBeenCalledWith({
      where: { purchaseOrderId: 102n, trackingNo: { notIn: ['YT222'] } },
    });
    expect(purchaseShipmentItemCreateMany).toHaveBeenCalledTimes(2);
  });
});
