import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PlatformMutationResultUnknownError,
  PlatformTokenRefreshRejectedError,
  PlatformTokenRefreshRetryableError,
  type AdapterConfig,
} from '../types';
import { DouyinAdapter } from './douyin';

const CONFIG: AdapterConfig = {
  appKey: 'app-key',
  appSecret: 'app-secret',
  customerMobile: '4001234567',
  serviceId: 'service-123',
  redirectUri: 'https://supplier.example.com/api/shops/oauth/douyin/callback',
};

const BASIC_CHILD_ORDER = {
  item_num: 1,
  origin_amount: 1000,
  sku_id: 'sku-1',
  sku_order_id: 'sku-order-1',
};

const BASIC_ORDER_VALUES = {
  create_time: 1_700_000_000,
  order_amount: 1000,
};

interface TestShipmentRoute {
  deliveryId: string;
  trackingNo: string;
  companyCode: string;
  carrier: string;
  items: Array<{ platformOrderItemId: string; quantity: number }>;
}

const PREVIOUS_SHIPMENT_ROUTES: TestShipmentRoute[] = [
  {
    deliveryId: 'delivery-1',
    trackingNo: 'SF-OLD-001',
    companyCode: 'shunfeng',
    carrier: '顺丰速运',
    items: [{ platformOrderItemId: 'sku-order-1', quantity: 2 }],
  },
  {
    deliveryId: 'delivery-2',
    trackingNo: 'YT-OLD-002',
    companyCode: 'yuantong',
    carrier: '圆通速递',
    items: [{ platformOrderItemId: 'sku-order-2', quantity: 1 }],
  },
];

const TARGET_SHIPMENT_ROUTES: TestShipmentRoute[] = [
  {
    deliveryId: 'delivery-1',
    trackingNo: 'SF-NEW-001',
    companyCode: 'shunfeng',
    carrier: '顺丰速运',
    items: [{ platformOrderItemId: 'sku-order-1', quantity: 2 }],
  },
  {
    deliveryId: 'delivery-2',
    trackingNo: 'YT-NEW-002',
    companyCode: 'yuantong',
    carrier: '圆通速递',
    items: [{ platformOrderItemId: 'sku-order-2', quantity: 1 }],
  },
];

function toDouyinLogisticsInfo(routes: TestShipmentRoute[]): Array<Record<string, unknown>> {
  return routes.map((route) => ({
    delivery_id: route.deliveryId,
    tracking_no: route.trackingNo,
    company: route.companyCode,
    company_name: route.carrier,
    product_info: route.items.map((item) => ({
      product_count: item.quantity,
      sku_order_id: item.platformOrderItemId,
    })),
  }));
}

function shipmentOrderDetail(
  routes: TestShipmentRoute[],
  orderStatus = 101,
): Record<string, unknown> {
  return {
    order_id: 'order-1',
    order_status: orderStatus,
    pay_amount: 3000,
    pay_time: 1_700_000_000,
    mask_post_receiver: '张*',
    mask_post_tel: '138****2222',
    mask_post_addr: {},
    sku_order_list: [
      {
        ...BASIC_CHILD_ORDER,
        item_num: 2,
        origin_amount: 2000,
        product_id: 'product-1',
        product_name: '商品一',
      },
      {
        ...BASIC_CHILD_ORDER,
        origin_amount: 1000,
        product_id: 'product-2',
        product_name: '商品二',
        sku_id: 'sku-2',
        sku_order_id: 'sku-order-2',
      },
    ],
    logistics_info: toDouyinLogisticsInfo(routes),
  };
}

function orderDetailResponse(routes: TestShipmentRoute[], orderStatus = 101): Response {
  return new Response(
    JSON.stringify({
      code: 10000,
      data: { shop_order_detail: shipmentOrderDetail(routes, orderStatus) },
    }),
    { status: 200 },
  );
}

function logisticsCompanyListResponse(): Response {
  return new Response(
    JSON.stringify({
      code: 10000,
      data: [{ id: 7, name: '圆通快递', code: 'yuantong' }],
    }),
    { status: 200 },
  );
}

function replaceShipPackagesDto(
  previousRoutes: TestShipmentRoute[] = PREVIOUS_SHIPMENT_ROUTES,
  targetRoutes: TestShipmentRoute[] = TARGET_SHIPMENT_ROUTES,
) {
  return {
    platformOrderId: 'order-1',
    previousPackages: previousRoutes.map((route) => ({
      trackingNo: route.trackingNo,
      carrier: route.carrier,
      items: route.items.map((item) => ({ ...item })),
    })),
    targetPackages: targetRoutes.map((route) => ({
      trackingNo: route.trackingNo,
      carrier: route.carrier,
      items: route.items.map((item) => ({ ...item })),
    })),
  };
}

describe('DouyinAdapter', () => {
  it('builds the official tool-app authorization URL with service_id and state only', () => {
    const url = new URL(new DouyinAdapter(CONFIG).buildAuthUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://fuwu.jinritemai.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      service_id: 'service-123',
      state: 'state-123',
    });
  });

  it('exchanges code using token.create with HMAC-SHA256 signing', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            err_no: 0,
            message: 'success',
            data: {
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              expires_in: 3600,
              scope: 'product order',
              shop_id: '4463798',
              shop_name: '测试店铺',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const now = 1_700_000_000_000;
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => now);

    const token = await adapter.exchangeToken('auth-code');

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    const paramJson = JSON.stringify({ code: 'auth-code', grant_type: 'authorization_code' });
    const signPayload =
      'app-secret' +
      `app_keyapp-keymethodtoken.createparam_json${paramJson}timestamp1700000000v2` +
      'app-secret';
    const expectedSign = createHmac('sha256', 'app-secret').update(signPayload).digest('hex');

    expect(url.origin + url.pathname).toBe('https://openapi-fxg.jinritemai.com/token/create');
    expect(url.searchParams.get('sign')).toBe(expectedSign);
    expect(url.searchParams.get('sign_method')).toBe('hmac-sha256');
    expect(init).toMatchObject({ method: 'POST', body: paramJson });
    expect(token).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(now + 3600_000),
      scope: ['product', 'order'],
      platformShopId: '4463798',
      shopName: '测试店铺',
    });
  });

  it('maps platform errors without exposing response payloads', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ err_no: 10001, message: 'invalid code' }), {
          status: 200,
        }),
    );
    await expect(adapter.exchangeToken('bad-code')).rejects.toThrow(
      'Douyin token exchange failed: invalid code',
    );
  });

  it('rejects malformed successful responses', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ err_no: 0, data: { access_token: 'token' } }), {
          status: 200,
        }),
    );
    await expect(adapter.exchangeToken('code')).rejects.toThrow(
      'Douyin token exchange returned an invalid response',
    );
  });

  it('refreshes tokens using token.refresh with sorted params', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            err_no: 0,
            data: {
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 7200,
              shop_id: '4463798',
              shop_name: '测试店铺',
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    const token = await adapter.refreshToken('old-refresh-token');

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/token/refresh');
    expect(url.searchParams.get('method')).toBe('token.refresh');
    expect(init?.body).toBe(
      JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'old-refresh-token' }),
    );
    expect(token.accessToken).toBe('new-access-token');
    expect(token.refreshToken).toBe('new-refresh-token');
  });

  it.each([
    ['a string err_no', { err_no: '0' }],
    ['an object code', { code: {} }],
    [
      'an unsafe numeric err_no',
      { err_no: Number.MAX_SAFE_INTEGER + 1, message: 'invalid refresh token' },
    ],
  ])('classifies %s as a malformed retryable response', async (_label, result) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            ...result,
            data: { access_token: 'access', expires_in: 7200, shop_id: '4463798' },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it.each([
    [10001, 'invalid refresh token', PlatformTokenRefreshRejectedError],
    [20001, 'service busy', PlatformTokenRefreshRetryableError],
  ])('does not let err_no=0 mask code=%s', async (code, message, expectedError) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            err_no: 0,
            code,
            message,
            data: { access_token: 'access', expires_in: 7200, shop_id: '4463798' },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(expectedError);
  });

  it.each([
    ['an unsafe numeric shop subject', Number.MAX_SAFE_INTEGER + 1],
    ['a whitespace-padded shop subject', ' 4463798'],
    ['a zero-prefixed shop subject', '04463798'],
    ['an overlong shop subject', '1'.repeat(65)],
  ])('classifies %s as a retryable response', async (_label, shopId) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            err_no: 0,
            data: { access_token: 'access', expires_in: 7200, shop_id: shopId },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it.each([
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
    ['1'.repeat(64), '1'.repeat(64)],
  ])('accepts the valid shop subject %s', async (shopId, expectedShopId) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            err_no: 0,
            data: { access_token: 'access', expires_in: 7200, shop_id: shopId },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.refreshToken('old-refresh-token')).resolves.toMatchObject({
      platformShopId: expectedShopId,
    });
  });

  it('classifies a token refresh transport failure as retryable', async () => {
    const adapter = new DouyinAdapter(CONFIG, async () => {
      throw new Error('socket timeout');
    });

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it.each([408, 425, 429, 500])('classifies token refresh HTTP %s as retryable', async (status) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ err_no: 10001, message: 'invalid refresh token' }), {
          status,
        }),
    );

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it('classifies malformed and unknown token refresh responses as retryable', async () => {
    const malformed = new DouyinAdapter(CONFIG, async () => new Response('{', { status: 200 }));
    const unknown = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ err_no: 20001, message: 'service busy' }), {
          status: 200,
        }),
    );
    const malformedFields = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ err_no: 20001, message: {} }), {
          status: 200,
        }),
    );

    await expect(malformed.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
    await expect(unknown.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
    await expect(malformedFields.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it.each([200, 400])(
    'classifies an explicit refresh credential rejection at HTTP %s as terminal',
    async (status) => {
      const adapter = new DouyinAdapter(
        CONFIG,
        async () =>
          new Response(JSON.stringify({ err_no: 10001, message: 'invalid refresh token' }), {
            status,
          }),
      );

      await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
        PlatformTokenRefreshRejectedError,
      );
    },
  );

  it.each([
    ['a blank shop subject', { access_token: 'access', expires_in: 7200, shop_id: '' }],
    ['an invalid shop subject', { access_token: 'access', expires_in: 7200, shop_id: {} }],
    ['an invalid numeric shop subject', { access_token: 'access', expires_in: 7200, shop_id: -1 }],
    ['a blank access token', { access_token: ' ', expires_in: 7200, shop_id: '4463798' }],
    [
      'an invalid refresh token',
      { access_token: 'access', refresh_token: {}, expires_in: 7200, shop_id: '4463798' },
    ],
    [
      'an out-of-range expiry',
      { access_token: 'access', expires_in: 31_536_001, shop_id: '4463798' },
    ],
  ])('classifies %s in a token refresh response as retryable', async (_label, data) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () => new Response(JSON.stringify({ err_no: 0, data }), { status: 200 }),
    );

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it('keeps an authorization service outage retryable instead of expiring the credential', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ err_no: 20001, message: '授权服务暂时失效' }), {
          status: 400,
        }),
    );

    await expect(adapter.refreshToken('old-refresh-token')).rejects.toBeInstanceOf(
      PlatformTokenRefreshRetryableError,
    );
  });

  it('publishes a product with canonical JSON and the official product.addV2 fields', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 10000, data: { product_id: '998877' } }), {
          status: 200,
        }),
    );
    const now = 1_700_000_000_000;
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => now);

    const result = await adapter.publishProduct('access-token', {
      externalProductId: 'supplier-57c747e7-861a-4913-90f7-8b856f6a7565',
      title: '纯棉短袖测试商品',
      detailHtml: '<img src="https://img.example/detail.jpg">',
      mainImages: ['https://img.example/main.jpg'],
      categoryId: '12345',
      attributes: {},
      skus: [
        {
          sourceSkuId: '1688-spec-white-m',
          specName: '白色/M',
          price: 29.9,
          stock: 12,
          attributes: { 颜色: '白色', 尺码: 'M' },
        },
        {
          sourceSkuId: '1688-spec-black-l',
          specName: '黑色/L',
          price: 32.9,
          stock: 8,
          attributes: { 颜色: '黑色', 尺码: 'L' },
        },
      ],
      salePrice: 29.9,
      categoryProperties: {
        '2176': [{ value: 111, name: '红色', diyType: 0 }],
        '3000': [{ value: 0, name: '纯棉', diyType: 1 }],
      },
      qualifications: [
        {
          qualityKey: '9001',
          qualityName: '质检报告',
          qualityContentName: '2026 年质检报告',
          qualityId: 9001,
          attachments: [{ mediaType: 1, url: 'https://cdn.example/quality.jpg' }],
        },
      ],
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    const body = String(init?.body);
    expect(url.pathname).toBe('/product/addV2');
    expect(url.searchParams.get('method')).toBe('product.addV2');
    expect(url.searchParams.get('access_token')).toBe('access-token');
    expect(url.searchParams.get('timestamp')).toBe('2023-11-15 06:13:20');
    expect(Object.keys(JSON.parse(body) as object)).toEqual([
      'category_leaf_id',
      'commit',
      'description',
      'freight_id',
      'mobile',
      'name',
      'outer_product_id',
      'pic',
      'product_format_new',
      'product_type',
      'quality_list',
      'reduce_type',
      'spec_name',
      'spec_prices',
      'specs',
    ]);
    expect(JSON.parse(body)).toMatchObject({
      category_leaf_id: 12345,
      commit: true,
      description: 'https://img.example/detail.jpg|https://img.example/main.jpg',
      mobile: '4001234567',
      outer_product_id: 'supplier-57c747e7-861a-4913-90f7-8b856f6a7565',
      pic: 'https://img.example/main.jpg',
      product_format_new: {
        '2176': [{ diy_type: 0, name: '红色', value: 111 }],
        '3000': [{ diy_type: 1, name: '纯棉', value: 0 }],
      },
      quality_list: [
        {
          quality_key: '9001',
          quality_name: '质检报告',
          quality_content_name: '2026 年质检报告',
          quality_id: 9001,
          quality_attachments: [{ media_type: 1, url: 'https://cdn.example/quality.jpg' }],
        },
      ],
      spec_name: '颜色|尺码',
      specs: '颜色|白色,黑色^尺码|M,L',
      spec_prices: JSON.stringify([
        {
          outer_sku_id: '1688-spec-white-m',
          price: 2990,
          spec_detail_name1: '白色',
          spec_detail_name2: 'M',
          stock_num: 12,
        },
        {
          outer_sku_id: '1688-spec-black-l',
          price: 3290,
          spec_detail_name1: '黑色',
          spec_detail_name2: 'L',
          stock_num: 8,
        },
      ]),
    });
    const signPayload =
      'app-secret' +
      `app_keyapp-keymethodproduct.addV2param_json${body}timestamp2023-11-15 06:13:20v2` +
      'app-secret';
    expect(url.searchParams.get('sign')).toBe(
      createHmac('sha256', 'app-secret').update(signPayload).digest('hex'),
    );
    expect(result).toEqual({ platformProductId: '998877' });
  });

  it('recovers a created product by its stable external product ID', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              product_id_str: '3558192687276554544',
              outer_product_id: 'supplier-retry-1',
              status: 1,
              check_status: 2,
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(
      adapter.findProductByExternalId('access-token', 'supplier-retry-1'),
    ).resolves.toEqual({ platformProductId: '3558192687276554544' });
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/product/detail');
    expect(url.searchParams.get('method')).toBe('product.detail');
    expect(JSON.parse(String(init?.body))).toEqual({
      out_product_id: 'supplier-retry-1',
      show_draft: 'true',
    });
  });

  it('returns null when no product exists for the external product ID', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 40004,
            sub_code: 'isv.parameter-invalid:4',
            sub_msg: 'out_product_id未找到或商品已删除',
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.findProductByExternalId('access-token', 'supplier-missing-1'),
    ).resolves.toBeNull();
  });

  it('rejects SKU mappings with more than three dimensions', async () => {
    const adapter = new DouyinAdapter(CONFIG, vi.fn());
    await expect(
      adapter.publishProduct('access-token', {
        title: '测试商品',
        detailHtml: '',
        mainImages: ['https://img.example/main.jpg'],
        categoryId: '12345',
        attributes: {},
        skus: [
          {
            specName: '组合',
            price: 29.9,
            stock: 12,
            attributes: { 颜色: '白', 尺码: 'M', 款式: '标准', 材质: '棉' },
          },
        ],
        salePrice: 29.9,
      }),
    ).rejects.toThrow('at most 3 SKU dimensions');
  });

  it('edits a product with product.editV2 and explicitly replaces qualifications', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.updateProduct('access-token', {
      platformProductId: '998877',
      title: '修正后的纯棉短袖商品',
      detailHtml: '<img src="https://img.example/detail.jpg">',
      mainImages: ['https://img.example/main.jpg'],
      categoryId: '12345',
      attributes: {},
      skus: [
        {
          sourceSkuId: '1688-spec-default',
          specName: '默认',
          price: 29.9,
          stock: 12,
          attributes: {},
        },
      ],
      salePrice: 29.9,
      categoryProperties: {
        '2176': [{ value: 111, name: '棉', diyType: 0 }],
      },
      qualifications: [],
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    expect(url.pathname).toBe('/product/editV2');
    expect(url.searchParams.get('method')).toBe('product.editV2');
    expect(body).toMatchObject({
      product_id: '998877',
      commit: true,
      force_use_quality_list: true,
      name: '修正后的纯棉短袖商品',
      product_format_new: {
        '2176': [{ diy_type: 0, name: '棉', value: 111 }],
      },
      quality_list: [],
    });
  });

  it('edits only the title through product.partialEdit', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.updateProductTitle('access-token', {
      platformProductId: '998877',
      title: '修正后的纯棉短袖商品',
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/product/partialEdit');
    expect(url.searchParams.get('method')).toBe('product.partialEdit');
    expect(JSON.parse(String(init?.body))).toEqual({
      name: '修正后的纯棉短袖商品',
      product_id: '998877',
    });
  });

  it('classifies an ambiguous product.partialEdit transport failure as result unknown', async () => {
    const adapter = new DouyinAdapter(CONFIG, vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(
      adapter.updateProductTitle('access-token', {
        platformProductId: '998877',
        title: '修正后的纯棉短袖商品',
      }),
    ).rejects.toBeInstanceOf(PlatformMutationResultUnknownError);
  });

  it('keeps a definitive product.partialEdit 400 response out of result-unknown recovery', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })),
    );

    const result = adapter.updateProductTitle('access-token', {
      platformProductId: '998877',
      title: '修正后的纯棉短袖商品',
    });
    await expect(result).rejects.toThrow('HTTP 400');
    await expect(result).rejects.not.toBeInstanceOf(PlatformMutationResultUnknownError);
  });

  it('classifies a product.partialEdit 500 response as result unknown', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );

    await expect(
      adapter.updateProductTitle('access-token', {
        platformProductId: '998877',
        title: '修正后的纯棉短袖商品',
      }),
    ).rejects.toBeInstanceOf(PlatformMutationResultUnknownError);
  });

  it.each([{}, { data: {} }, { code: '10000', data: {} }])(
    'classifies a product.partialEdit response with an invalid code as result unknown',
    async (payload) => {
      const adapter = new DouyinAdapter(
        CONFIG,
        vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })),
      );

      await expect(
        adapter.updateProductTitle('access-token', {
          platformProductId: '998877',
          title: '修正后的纯棉短袖商品',
        }),
      ).rejects.toBeInstanceOf(PlatformMutationResultUnknownError);
    },
  );

  it('trims and enforces the weighted Douyin title boundary before partialEdit', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await adapter.updateProductTitle('access-token', {
      platformProductId: '998877',
      title: '  夏季轻薄纯棉短袖  ',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      name: '夏季轻薄纯棉短袖',
    });
    await expect(
      adapter.updateProductTitle('access-token', {
        platformProductId: '998877',
        title: '好'.repeat(31),
      }),
    ).rejects.toThrow('invalid');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the draft-aware product title from product.detail data.name', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              product_id_str: '998877',
              name: '修正后的纯棉短袖商品',
              status: 1,
              check_status: 2,
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getProductTitle('access-token', '998877')).resolves.toEqual({
      title: '修正后的纯棉短袖商品',
      state: 'reviewing',
      status: 1,
      checkStatus: 2,
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/detail');
    expect(JSON.parse(String(init?.body))).toEqual({
      product_id: '998877',
      show_draft: 'true',
    });
  });

  it('rejects product.detail when the title is missing', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ code: 10000, data: { product_id: '998877', status: 1 } }), {
          status: 200,
        }),
    );

    await expect(adapter.getProductTitle('access-token', '998877')).rejects.toThrow(
      'invalid product title',
    );
  });

  it('updates one SKU to an absolute integer-cent price through sku.editPrice', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.updateProductPrice('access-token', {
      platformProductId: '998877',
      sourceSkuId: '1688-spec-white-m',
      priceCents: 2990,
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/sku/editPrice');
    expect(url.searchParams.get('method')).toBe('sku.editPrice');
    expect(JSON.parse(String(init?.body))).toEqual({
      out_sku_id: '1688-spec-white-m',
      price: 2990,
      product_id: '998877',
    });
  });

  it('rejects a non-integer SKU price before calling sku.editPrice', async () => {
    const fetcher = vi.fn();
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.updateProductPrice('access-token', {
        platformProductId: '998877',
        sourceSkuId: '1688-spec-white-m',
        priceCents: 2990.5,
      }),
    ).rejects.toThrow('SKU price in cents is invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads, validates and stably sorts all product SKU prices', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              product_id: '998877',
              status: 0,
              check_status: 3,
              spec_prices: [
                { outer_sku_id: 'sku-z', price: 3290 },
                { outer_sku_id: 'sku-a', price: 2990 },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getProductPrices('access-token', '998877')).resolves.toEqual({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [
        { sourceSkuId: 'sku-a', priceCents: 2990 },
        { sourceSkuId: 'sku-z', priceCents: 3290 },
      ],
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/detail');
    expect(new URL(String(input)).searchParams.get('method')).toBe('product.detail');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: '998877' });
  });

  it.each([
    ['a missing price list', undefined],
    ['an empty price list', []],
    ['a missing external SKU ID', [{ price: 2990 }]],
    ['a non-positive price', [{ outer_sku_id: 'sku-a', price: 0 }]],
    [
      'a duplicate external SKU ID',
      [
        { outer_sku_id: 'sku-a', price: 2990 },
        { outer_sku_id: 'sku-a', price: 3290 },
      ],
    ],
  ])('rejects product.detail with %s', async (_label, specPrices) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: { product_id: '998877', status: 0, check_status: 3, spec_prices: specPrices },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getProductPrices('access-token', '998877')).rejects.toThrow();
  });

  it('reads, validates and stably sorts all product SKU inventory', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              product_id: '998877',
              status: 0,
              check_status: 3,
              spec_prices: [
                { outer_sku_id: 'sku-z', stock_num: 0 },
                { outer_sku_id: 'sku-a', stock_num: 12 },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getProductInventory('access-token', '998877')).resolves.toEqual({
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [
        { sourceSkuId: 'sku-a', stock: 12 },
        { sourceSkuId: 'sku-z', stock: 0 },
      ],
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/detail');
    expect(new URL(String(input)).searchParams.get('method')).toBe('product.detail');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: '998877' });
  });

  it.each([
    ['a missing inventory list', undefined],
    ['an empty inventory list', []],
    ['a missing external SKU ID', [{ stock_num: 12 }]],
    ['a missing stock value', [{ outer_sku_id: 'sku-a' }]],
    ['a negative stock value', [{ outer_sku_id: 'sku-a', stock_num: -1 }]],
    ['a fractional stock value', [{ outer_sku_id: 'sku-a', stock_num: 1.5 }]],
    [
      'a duplicate external SKU ID',
      [
        { outer_sku_id: 'sku-a', stock_num: 12 },
        { outer_sku_id: 'sku-a', stock_num: 8 },
      ],
    ],
  ])('rejects product.detail with %s', async (_label, specPrices) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: { product_id: '998877', status: 0, check_status: 3, spec_prices: specPrices },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getProductInventory('access-token', '998877')).rejects.toThrow();
  });

  it('maps product.detail audit status before the shop online status', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: { product_id: '998877', status: 0, check_status: 4 },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getProductState('access-token', '998877')).resolves.toEqual({
      state: 'rejected',
      status: 0,
      checkStatus: 4,
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/detail');
    expect(new URL(String(input)).searchParams.get('method')).toBe('product.detail');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: '998877' });
  });

  it('rejects a product-state readback for a different product', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              code: 10000,
              data: { product_id: '998878', status: 0, check_status: 3 },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(adapter.getProductState('access-token', '998877')).rejects.toThrow(
      'mismatched product ID',
    );
  });

  it('rejects every strong product readback when product.detail omits the product ID', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              code: 10000,
              data: {
                name: '修正后的纯棉短袖商品',
                status: 0,
                check_status: 3,
                spec_prices: [{ outer_sku_id: 'sku-a', price: 2990, stock_num: 12 }],
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(adapter.getProductState('access-token', '998877')).rejects.toThrow(
      'mismatched product ID',
    );
    await expect(adapter.getProductInventory('access-token', '998877')).rejects.toThrow(
      'mismatched product ID',
    );
    await expect(adapter.getProductPrices('access-token', '998877')).rejects.toThrow(
      'mismatched product ID',
    );
    await expect(adapter.getProductTitle('access-token', '998877')).rejects.toThrow(
      'mismatched product ID',
    );
  });

  it.each([null, 0, 6, 99])(
    'maps unrecognized audit status %s to unknown even when status says online',
    async (checkStatus) => {
      const adapter = new DouyinAdapter(
        CONFIG,
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              code: 10000,
              data: { product_id: '998877', status: 0, check_status: checkStatus },
            }),
            { status: 200 },
          ),
        ),
      );

      await expect(adapter.getProductState('access-token', '998877')).resolves.toMatchObject({
        state: 'unknown',
        status: 0,
      });
    },
  );

  it.each([null, '', false])(
    'does not coerce malformed product status %j to online',
    async (status) => {
      const adapter = new DouyinAdapter(
        CONFIG,
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              code: 10000,
              data: { product_id: '998877', status, check_status: 3 },
            }),
            { status: 200 },
          ),
        ),
      );

      await expect(adapter.getProductState('access-token', '998877')).resolves.toEqual({
        state: 'unknown',
        status: null,
        checkStatus: 3,
      });
    },
  );

  it('syncs absolute SKU inventory through the official batch endpoint', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              results: [
                { uniq_id: '1', status_code: '0' },
                { uniq_id: '2', status_code: '0' },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.syncInventory('access-token', {
      platformProductId: '998877665544332211',
      idempotencyKey: 'inventory-7-abcdef',
      items: [
        { sourceSkuId: '1688-spec-white-m', stock: 12 },
        { sourceSkuId: '1688-spec-black-l', stock: 0 },
      ],
    });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/sku/syncStockBatchMultiProducts');
    expect(url.searchParams.get('method')).toBe('sku.syncStockBatchMultiProducts');
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotent_id: 'inventory-7-abcdef',
      incremental: false,
      inventory_loss: false,
      items: [
        {
          out_sku_id: '1688-spec-white-m',
          product_id: '998877665544332211',
          stock_num: 12,
          uniq_id: '1',
        },
        {
          out_sku_id: '1688-spec-black-l',
          product_id: '998877665544332211',
          stock_num: 0,
          uniq_id: '2',
        },
      ],
      source: 'supplier',
    });
  });

  it('treats a reused successful inventory idempotency token as already applied', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 50002,
            sub_code: 'isv.business-failed:-20002',
            sub_msg: 'Token已被使用',
          }),
          { status: 200 },
        ),
    );

    await expect(
      adapter.syncInventory('access-token', {
        platformProductId: '998877',
        idempotencyKey: 'inventory-7-abcdef',
        items: [{ sourceSkuId: '1688-spec-white-m', stock: 12 }],
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['missing data', undefined],
    ['missing results', {}],
    ['an incomplete result list', { results: [{ uniq_id: '1', status_code: '0' }] }],
    [
      'an unexpected result ID',
      {
        results: [
          { uniq_id: '1', status_code: '0' },
          { uniq_id: '3', status_code: '0' },
        ],
      },
    ],
    ['a missing status code', { results: [{ uniq_id: '1' }, { uniq_id: '2', status_code: '0' }] }],
    [
      'a non-integer status code',
      {
        results: [
          { uniq_id: '1', status_code: 'success' },
          { uniq_id: '2', status_code: '0' },
        ],
      },
    ],
  ])('rejects a successful inventory response with %s', async (_label, data) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ code: 10000, ...(data === undefined ? {} : { data }) }), {
          status: 200,
        }),
    );

    const result = adapter.syncInventory('access-token', {
      platformProductId: '998877',
      idempotencyKey: 'inventory-7-abcdef',
      items: [
        { sourceSkuId: '1688-spec-white-m', stock: 12 },
        { sourceSkuId: '1688-spec-black-l', stock: 8 },
      ],
    });
    await expect(result).rejects.toBeInstanceOf(PlatformMutationResultUnknownError);
    await expect(result).rejects.toThrow('Douyin inventory sync returned an invalid response');
  });

  it('accepts numeric inventory status codes', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: { results: [{ uniq_id: '1', status_code: 0 }] },
          }),
          { status: 200 },
        ),
    );

    await expect(
      adapter.syncInventory('access-token', {
        platformProductId: '998877',
        idempotencyKey: 'inventory-7-abcdef',
        items: [{ sourceSkuId: '1688-spec-white-m', stock: 12 }],
      }),
    ).resolves.toBeUndefined();
  });

  it('marks a transport failure as an unknown inventory mutation result', async () => {
    const adapter = new DouyinAdapter(CONFIG, async () => {
      throw new Error('socket timeout');
    });

    await expect(
      adapter.syncInventory('access-token', {
        platformProductId: '998877',
        idempotencyKey: 'inventory-7-abcdef',
        items: [{ sourceSkuId: '1688-spec-white-m', stock: 12 }],
      }),
    ).rejects.toBeInstanceOf(PlatformMutationResultUnknownError);
  });

  it('keeps an explicit per-item inventory failure retryable as a known partial result', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: { results: [{ uniq_id: '1', status_code: '30001' }] },
          }),
          { status: 200 },
        ),
    );

    const result = adapter.syncInventory('access-token', {
      platformProductId: '998877',
      idempotencyKey: 'inventory-7-abcdef',
      items: [{ sourceSkuId: '1688-spec-white-m', stock: 12 }],
    });
    await expect(result).rejects.not.toBeInstanceOf(PlatformMutationResultUnknownError);
    await expect(result).rejects.toThrow('Douyin inventory sync failed for item 1');
  });

  it('offlines a product through the dedicated product endpoint', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.offlineProduct('access-token', '998877')).resolves.toBeUndefined();
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/product/setOffline');
    expect(url.searchParams.get('method')).toBe('product.setOffline');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: '998877' });
  });

  it('treats an already-offline response as success', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 40004,
            sub_code: 'isv.parameter-invalid:2010021',
            sub_msg: '商品操作重复，当前状态：下架',
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.offlineProduct('access-token', '998877')).resolves.toBeUndefined();
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/setOffline');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: '998877' });
  });

  it.each([
    ['transport failure', vi.fn().mockRejectedValue(new Error('socket closed'))],
    ['HTTP 408', vi.fn().mockResolvedValue(new Response('request timeout', { status: 408 }))],
    ['HTTP 429', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))],
    ['HTTP 500', vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))],
    [
      'a malformed response',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    ],
  ])('classifies product.setOffline %s as result unknown', async (_label, fetcher) => {
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(adapter.offlineProduct('access-token', '998877')).rejects.toBeInstanceOf(
      PlatformMutationResultUnknownError,
    );
  });

  it('keeps a definitive product.setOffline HTTP 400 response out of result-unknown recovery', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })),
    );

    const result = adapter.offlineProduct('access-token', '998877');
    await expect(result).rejects.toThrow('HTTP 400');
    await expect(result).rejects.not.toBeInstanceOf(PlatformMutationResultUnknownError);
  });

  it('onlines a product through the dedicated product endpoint', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, data: {} }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.onlineProduct('access-token', '998877')).resolves.toBeUndefined();
    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe('/product/setOnline');
    expect(url.searchParams.get('method')).toBe('product.setOnline');
    expect(JSON.parse(String(init?.body))).toEqual({ product_id: '998877' });
  });

  it('classifies an ambiguous product.setOnline response as result unknown', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 })),
    );

    await expect(adapter.onlineProduct('access-token', '998877')).rejects.toBeInstanceOf(
      PlatformMutationResultUnknownError,
    );
  });

  it.each([
    ['transport failure', vi.fn().mockRejectedValue(new Error('socket closed'))],
    ['HTTP 500', vi.fn().mockResolvedValue(new Response('server error', { status: 500 }))],
  ])('classifies product.setOnline %s as result unknown', async (_label, fetcher) => {
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(adapter.onlineProduct('access-token', '998877')).rejects.toBeInstanceOf(
      PlatformMutationResultUnknownError,
    );
  });

  it('keeps a definitive product.setOnline HTTP 400 response out of result-unknown recovery', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })),
    );

    const result = adapter.onlineProduct('access-token', '998877');
    await expect(result).rejects.toThrow('HTTP 400');
    await expect(result).rejects.not.toBeInstanceOf(PlatformMutationResultUnknownError);
  });

  it('recursively loads the enabled official shop category tree', async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { cid: number };
      const data =
        body.cid === 0
          ? [
              {
                id: '20000',
                name: '女装',
                level: 1,
                parent_id: '0',
                is_leaf: false,
                enable: true,
                channel: 0,
              },
            ]
          : [
              {
                id: '20001',
                name: 'T恤',
                level: 2,
                parent_id: '20000',
                is_leaf: true,
                enable: true,
                channel: 0,
              },
            ];
      return new Response(JSON.stringify({ code: 10000, data }), { status: 200 });
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getCategoryTree('access-token')).resolves.toEqual([
      {
        id: '20000',
        name: '女装',
        isLeaf: false,
        level: 1,
        enabled: true,
        channel: 0,
      },
      {
        id: '20001',
        name: 'T恤',
        parentId: '20000',
        isLeaf: true,
        level: 2,
        enabled: true,
        channel: 0,
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe('/shop/getShopCategory');
  });

  it('maps the official category prediction response without inventing confidence', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              recommend_id: 'recommend-1',
              categoryDetails: [
                {
                  category_detail: {
                    first_cid: '20000',
                    first_cname: '女装',
                    second_cid: '20001',
                    second_cname: 'T恤',
                  },
                  qualification_status: 0,
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(
      adapter.recommendCategories('access-token', { title: '纯棉短袖 T 恤' }),
    ).resolves.toEqual({
      recommendId: 'recommend-1',
      recommendations: [
        {
          categoryId: '20001',
          categoryName: 'T恤',
          categoryPath: '女装/T恤',
          qualificationStatus: 0,
        },
      ],
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/GetRecommendCategory');
    expect(JSON.parse(String(init?.body))).toEqual({
      name: '纯棉短袖 T 恤',
      scene: 'category_infer',
    });
  });

  it('maps common category attributes and flags unsupported required rules', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              data: [
                {
                  property_id: '2176',
                  property_name: '颜色',
                  require: 1,
                  status: 0,
                  type: 'select',
                  property_type: 3,
                  diy_type: 0,
                  options: [{ value_id: '111', name: '红色' }],
                },
                {
                  property_id: '3000',
                  property_name: '净含量',
                  require: 1,
                  status: 0,
                  type: 'text',
                  property_type: 3,
                  diy_type: 1,
                  measure_templates: [{ template_id: 1 }],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getCategoryAttributes('access-token', '20001')).resolves.toEqual([
      {
        id: '2176',
        name: '颜色',
        required: true,
        multiValue: false,
        inputType: 'select',
        supportsCustom: false,
        values: [{ id: '111', name: '红色' }],
      },
      {
        id: '3000',
        name: '净含量',
        required: true,
        multiValue: false,
        inputType: 'unsupported',
        supportsCustom: true,
        unsupportedReason: '度量衡属性',
      },
    ]);
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/getCatePropertyV2');
    expect(JSON.parse(String(init?.body))).toEqual({
      category_leaf_id: 20001,
      need_process_prop_cascade: true,
    });
  });

  it('maps product.qualificationConfig including dynamic property rules', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              config_list: [
                {
                  key: '9001',
                  name: '质检报告',
                  text_list: ['请上传清晰、有效的质检报告'],
                  is_required: 0,
                  matchable_rule: [
                    {
                      rule_clause: {
                        '2176': { property_values: ['111'], operand_str: '等于' },
                      },
                      is_qualification_required: 1,
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await expect(adapter.getCategoryQualifications('access-token', '20001')).resolves.toEqual([
      {
        key: '9001',
        name: '质检报告',
        hints: ['请上传清晰、有效的质检报告'],
        required: false,
        rules: [
          {
            clauses: [{ propertyId: '2176', propertyValues: ['111'], operand: 'equal' }],
            required: true,
          },
        ],
      },
    ]);
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/product/qualificationConfig');
    expect(new URL(String(input)).searchParams.get('method')).toBe('product.qualificationConfig');
    expect(JSON.parse(String(init?.body))).toEqual({ category_id: 20001 });
  });

  it('maps order.searchList responses to the shared order shape', async () => {
    const encrypted = {
      receiver: 'receiver-envelope-without-markers',
      phone: 'phone-envelope-without-markers',
      detail: 'detail-envelope-without-markers',
    };
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/searchList') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  order_id: 'order-1',
                  order_status: 105,
                  pay_amount: 5980,
                  pay_time: 1_700_000_000,
                  user_nick_name: '买家A',
                  encrypt_post_receiver: encrypted.receiver,
                  encrypt_post_tel: encrypted.phone,
                  post_addr: {
                    province: { name: '浙江省' },
                    city: { name: '杭州市' },
                    town: { name: '余杭区' },
                    street: { name: '仓前街道' },
                    encrypt_detail: encrypted.detail,
                  },
                  sku_order_list: [
                    {
                      product_id: 'product-1',
                      sku_id: 'sku-1',
                      sku_order_id: 'sku-order-1',
                      out_sku_id: '1688-spec-white-m',
                      product_name: '纯棉短袖',
                      item_num: 2,
                      origin_amount: 2990,
                      after_sale_info: {
                        after_sale_status: 12,
                        after_sale_type: 2,
                        refund_status: 3,
                      },
                      spec: [
                        { name: '颜色', value: '白色' },
                        { name: '尺码', value: 'M' },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (path === '/order/batchDecrypt') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              decrypt_infos: [
                { cipher_text: encrypted.receiver, decrypt_text: '张三', err_no: 0 },
                { cipher_text: encrypted.phone, decrypt_text: '13811112222', err_no: 0 },
                { cipher_text: encrypted.detail, decrypt_text: '文一西路 969 号', err_no: 0 },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    const orders = await adapter.listOrders('access-token', {
      cursor: '2',
      pageSize: 150,
      status: '105,2',
    });

    const [, init] = fetcher.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      combine_status: [{ order_status: '105,2' }],
      page: 2,
      size: 100,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(orders).toEqual([
      {
        amount: 59.8,
        buyerNick: '买家A',
        paidAt: new Date(1_700_000_000_000),
        platformOrderId: 'order-1',
        receiverAddress: '浙江省杭州市余杭区仓前街道文一西路 969 号',
        receiverAddressDetail: {
          province: '浙江省',
          city: '杭州市',
          area: '余杭区',
          town: '仓前街道',
          detail: '文一西路 969 号',
        },
        receiverName: '张三',
        receiverPhone: '13811112222',
        shipmentPackages: [],
        skuList: [
          {
            afterSaleStatus: 12,
            afterSaleType: 2,
            platformOrderItemId: 'sku-order-1',
            platformProductId: 'product-1',
            quantity: 2,
            refundStatus: 3,
            skuId: 'sku-1',
            sourceSkuId: '1688-spec-white-m',
            specs: { 颜色: '白色', 尺码: 'M' },
            title: '纯棉短袖',
            unitPrice: 29.9,
          },
        ],
        status: 'paid',
      },
    ]);
  });

  it('fails closed instead of dropping a malformed parent order from a list', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [BASIC_CHILD_ORDER],
                },
                null,
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained an invalid order',
    );
  });

  it('fails closed instead of dropping a malformed child order', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [BASIC_CHILD_ORDER, { sku_order_id: 'broken-child' }],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained an invalid child order',
    );
  });

  it('fails closed when a parent order has no child orders', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [{ order_id: 'order-1', order_status: 4, sku_order_list: [] }],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained an invalid child order list',
    );
  });

  it('fails closed when child order IDs are duplicated', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [BASIC_CHILD_ORDER, BASIC_CHILD_ORDER],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained duplicate child orders',
    );
  });

  it.each([
    ['a missing order amount', { order_amount: undefined }],
    ['a negative order amount', { order_amount: -1 }],
    ['a missing order timestamp', { create_time: undefined }],
    ['a non-positive order timestamp', { create_time: 0 }],
  ])('fails closed for %s', async (_label, invalidValues) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  ...invalidValues,
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [BASIC_CHILD_ORDER],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained invalid order values',
    );
  });

  it.each([
    ['a missing child quantity', { item_num: undefined }],
    ['a zero child quantity', { item_num: 0 }],
    ['a fractional child quantity', { item_num: 1.5 }],
    ['a missing child price', { origin_amount: undefined }],
    ['a negative child price', { origin_amount: -1 }],
  ])('fails closed for %s', async (_label, invalidValues) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [{ ...BASIC_CHILD_ORDER, ...invalidValues }],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained invalid child order values',
    );
  });

  it('derives unit price from a valid child total when origin amount is absent', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [
                    {
                      ...BASIC_CHILD_ORDER,
                      item_num: 2,
                      origin_amount: undefined,
                      pay_amount: 3000,
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    const [order] = await adapter.listOrders('access-token', {});

    expect(order.skuList[0]?.unitPrice).toBe(15);
  });

  it.each([
    ['a non-object after-sale block', 'broken'],
    ['a non-integer after-sale status', { after_sale_status: 'broken' }],
    ['a fractional after-sale type', { after_sale_type: 1.5 }],
    ['a negative refund status', { refund_status: -1 }],
  ])('fails closed for %s', async (_label, afterSaleInfo) => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [{ ...BASIC_CHILD_ORDER, after_sale_info: afterSaleInfo }],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order response contained invalid child after-sale values',
    );
  });

  it('preserves explicit zero after-sale values', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 4,
                  sku_order_list: [
                    {
                      ...BASIC_CHILD_ORDER,
                      after_sale_info: {
                        after_sale_status: 0,
                        after_sale_type: 0,
                        refund_status: 0,
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    const [order] = await adapter.listOrders('access-token', {});

    expect(order.skuList[0]).toMatchObject({
      afterSaleStatus: 0,
      afterSaleType: 0,
      refundStatus: 0,
    });
  });

  it('reads the latest child-order after-sale state from order.orderDetail', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_detail: {
                order_id: 'order-1',
                order_status: 5,
                pay_amount: 2990,
                pay_time: 1_700_000_000,
                mask_post_receiver: '张*',
                mask_post_tel: '138****2222',
                mask_post_addr: {},
                sku_order_list: [
                  {
                    product_id: 'product-1',
                    sku_id: 'sku-1',
                    sku_order_id: 'sku-order-1',
                    product_name: '纯棉短袖',
                    item_num: 1,
                    origin_amount: 2990,
                    after_sale_info: {
                      after_sale_status: 12,
                      after_sale_type: 2,
                      refund_status: 3,
                    },
                  },
                ],
                logistics_info: [
                  {
                    delivery_id: 'delivery-1',
                    tracking_no: 'SF123456',
                    company: 'shunfeng',
                    company_name: '顺丰速运',
                    product_info: [{ sku_order_id: 'sku-order-1', product_count: 1 }],
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    const order = await adapter.getOrder('access-token', 'order-1');

    expect(order.status).toBe('received');
    expect(order.skuList[0]).toMatchObject({
      platformOrderItemId: 'sku-order-1',
      afterSaleStatus: 12,
      afterSaleType: 2,
      refundStatus: 3,
    });
    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/order/orderDetail');
    expect(new URL(String(input)).searchParams.get('method')).toBe('order.orderDetail');
    expect(JSON.parse(String(init?.body))).toEqual({ shop_order_id: 'order-1' });
  });

  it('rejects an orderDetail response for a different parent order', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_detail: {
                ...BASIC_ORDER_VALUES,
                order_id: 'another-order',
                order_status: 4,
                sku_order_list: [BASIC_CHILD_ORDER],
              },
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getOrder('access-token', 'order-1')).rejects.toThrow(
      'Douyin order detail returned a different order',
    );
  });

  it('decrypts paid-order receiver fields in batches before exposing them to the BFF', async () => {
    const encrypted = {
      receiver: '#receiver-encrypted-value-123456#',
      phone: '#phone-encrypted-value-123456789#',
      detail: '#address-encrypted-value-123456#',
    };
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/searchList') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  order_id: 'order-1',
                  order_status: 105,
                  pay_amount: 1000,
                  pay_time: 1_700_000_000,
                  encrypt_post_receiver: encrypted.receiver,
                  encrypt_post_tel: encrypted.phone,
                  post_addr: {
                    province: { name: '浙江省' },
                    city: { name: '杭州市' },
                    town: { name: '余杭区' },
                    encrypt_detail: encrypted.detail,
                  },
                  sku_order_list: [BASIC_CHILD_ORDER],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (path === '/order/batchDecrypt') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              decrypt_infos: [
                { cipher_text: encrypted.receiver, decrypt_text: '张三', err_no: 0 },
                { cipher_text: encrypted.phone, decrypt_text: '13811112222', err_no: 0 },
                { cipher_text: encrypted.detail, decrypt_text: '文一西路 969 号', err_no: 0 },
              ],
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    const [order] = await adapter.listOrders('access-token', {});

    expect(order).toMatchObject({
      receiverName: '张三',
      receiverPhone: '13811112222',
      receiverAddressDetail: { detail: '文一西路 969 号' },
    });
    const [, decryptInit] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(decryptInit?.body))).toEqual({
      cipher_infos: [
        { auth_id: 'order-1', cipher_text: encrypted.receiver },
        { auth_id: 'order-1', cipher_text: encrypted.phone },
        { auth_id: 'order-1', cipher_text: encrypted.detail },
      ],
    });
  });

  it('deduplicates repeated paid-order fields by auth ID and ciphertext', async () => {
    const cipherText = 'shared-receiver-phone-cipher';
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/searchList') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 105,
                  encrypt_post_receiver: cipherText,
                  encrypt_post_tel: cipherText,
                  sku_order_list: [BASIC_CHILD_ORDER],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          code: 10000,
          data: {
            decrypt_infos: [
              {
                auth_id: 'order-1',
                cipher_text: cipherText,
                decrypt_text: '张三',
                err_no: 0,
              },
            ],
          },
        }),
        { status: 200 },
      );
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    const [order] = await adapter.listOrders('access-token', {});

    expect(order).toMatchObject({ receiverName: '张三', receiverPhone: '张三' });
    const [, decryptInit] = fetcher.mock.calls[1]!;
    expect(JSON.parse(String(decryptInit?.body))).toEqual({
      cipher_infos: [{ auth_id: 'order-1', cipher_text: cipherText }],
    });
  });

  it('separates identical ciphertext belonging to different orders', async () => {
    const cipherText = 'shared-cipher-across-orders';
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/searchList') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: ['order-1', 'order-2'].map((orderId) => ({
                ...BASIC_ORDER_VALUES,
                order_id: orderId,
                order_status: 105,
                encrypt_post_receiver: cipherText,
                sku_order_list: [BASIC_CHILD_ORDER],
              })),
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          code: 10000,
          data: {
            decrypt_infos: [{ cipher_text: cipherText, decrypt_text: '张三', err_no: 0 }],
          },
        }),
        { status: 200 },
      );
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    const orders = await adapter.listOrders('access-token', {});

    expect(orders.map((order) => order.receiverName)).toEqual(['张三', '张三']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { cipher_infos: [{ auth_id: 'order-1', cipher_text: cipherText }] },
      { cipher_infos: [{ auth_id: 'order-2', cipher_text: cipherText }] },
    ]);
  });

  it('fails closed when paid-order decryption omits a requested field', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/searchList') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  order_id: 'order-1',
                  order_status: 105,
                  encrypt_post_receiver: 'receiver-cipher',
                  encrypt_post_tel: 'phone-cipher',
                  post_addr: {
                    province: { name: '浙江省' },
                    city: { name: '杭州市' },
                    town: { name: '余杭区' },
                    encrypt_detail: 'detail-cipher',
                  },
                  sku_order_list: [BASIC_CHILD_ORDER],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          code: 10000,
          data: {
            decrypt_infos: [
              { cipher_text: 'receiver-cipher', decrypt_text: '张三', err_no: 0 },
              { cipher_text: 'phone-cipher', decrypt_text: '13811112222', err_no: 0 },
            ],
          },
        }),
        { status: 200 },
      );
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(adapter.listOrders('access-token', {})).rejects.toThrow(
      'Douyin order decryption did not return every requested field',
    );
  });

  it('uses masked fields without decryption for non-paid orders', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 10000,
            data: {
              shop_order_list: [
                {
                  ...BASIC_ORDER_VALUES,
                  order_id: 'order-1',
                  order_status: 1,
                  mask_post_receiver: '张*',
                  mask_post_tel: '138****2222',
                  mask_post_addr: {
                    province: { name: '浙江省' },
                    city: { name: '杭州市' },
                    town: { name: '余杭区' },
                    detail: '文一西路***号',
                  },
                  sku_order_list: [BASIC_CHILD_ORDER],
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    const [order] = await adapter.listOrders('access-token', {});

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(order).toMatchObject({
      receiverName: '张*',
      receiverPhone: '138****2222',
      receiverAddressDetail: { detail: '文一西路***号' },
    });
  });

  it('ships the parent order through order.logisticsAdd', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ code: 10000, msg: 'success' }), { status: 200 }),
    );
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.shipOrder('access-token', {
      platformOrderId: 'order-1',
      trackingNo: 'SF123456',
      carrier: '顺丰速运',
    });

    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe('/order/logisticsAdd');
    expect(JSON.parse(String(init?.body))).toEqual({
      company: '顺丰速运',
      company_code: 'shunfeng',
      logistics_code: 'SF123456',
      order_id: 'order-1',
    });
  });

  it('ships deterministic item-to-package mappings through order.logisticsAddMultiPack', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (new URL(String(input)).pathname === '/order/logisticsCompanyList') {
        return new Response(
          JSON.stringify({
            code: 10000,
            data: [{ id: 7, name: '圆通快递', code: 'yuantong' }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ code: 10000, msg: 'success' }), { status: 200 });
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.shipPackages('access-token', {
      platformOrderId: 'order-1',
      requestId: '4b53fd7f-8377-4ad8-9f31-47f0a1b74ce7',
      packages: [
        {
          trackingNo: 'SF123456',
          carrier: '顺丰速运',
          items: [{ platformOrderItemId: 'sku-order-1', quantity: 2 }],
        },
        {
          trackingNo: 'YT987654',
          carrier: '圆通速递',
          items: [{ platformOrderItemId: 'sku-order-2', quantity: 1 }],
        },
      ],
    });

    const [input, init] = fetcher.mock.calls[1]!;
    expect(new URL(String(input)).pathname).toBe('/order/logisticsAddMultiPack');
    expect(JSON.parse(String(init?.body))).toEqual({
      order_id: 'order-1',
      pack_list: [
        {
          company: '顺丰速运',
          company_code: 'shunfeng',
          logistics_code: 'SF123456',
          shipped_order_info: [{ shipped_num: 2, shipped_order_id: 'sku-order-1' }],
        },
        {
          company: '圆通速递',
          company_code: 'yuantong',
          logistics_code: 'YT987654',
          shipped_order_info: [{ shipped_num: 1, shipped_order_id: 'sku-order-2' }],
        },
      ],
      request_id: '4b53fd7f-8377-4ad8-9f31-47f0a1b74ce7',
    });
  });

  it('maps orderDetail logistics_info into a strict shipment package snapshot', async () => {
    const adapter = new DouyinAdapter(CONFIG, async () =>
      orderDetailResponse(PREVIOUS_SHIPMENT_ROUTES),
    );

    const order = await adapter.getOrder('access-token', 'order-1');

    expect(order.shipmentPackages).toEqual([
      {
        deliveryId: 'delivery-1',
        trackingNo: 'SF-OLD-001',
        companyCode: 'shunfeng',
        carrier: '顺丰速运',
        items: [{ platformOrderItemId: 'sku-order-1', quantity: 2 }],
      },
      {
        deliveryId: 'delivery-2',
        trackingNo: 'YT-OLD-002',
        companyCode: 'yuantong',
        carrier: '圆通速递',
        items: [{ platformOrderItemId: 'sku-order-2', quantity: 1 }],
      },
    ]);
  });

  const invalidShipmentPackageCases: Array<
    [string, (logisticsInfo: Array<Record<string, unknown>>) => void]
  > = [
    [
      'missing delivery ID',
      (logisticsInfo) => {
        delete logisticsInfo[0]!.delivery_id;
      },
    ],
    [
      'missing tracking number',
      (logisticsInfo) => {
        delete logisticsInfo[0]!.tracking_no;
      },
    ],
    [
      'missing company code',
      (logisticsInfo) => {
        delete logisticsInfo[0]!.company;
      },
    ],
    [
      'missing carrier name',
      (logisticsInfo) => {
        delete logisticsInfo[0]!.company_name;
      },
    ],
    [
      'missing products',
      (logisticsInfo) => {
        delete logisticsInfo[0]!.product_info;
      },
    ],
    [
      'a non-positive product quantity',
      (logisticsInfo) => {
        const products = logisticsInfo[0]!.product_info as Array<Record<string, unknown>>;
        products[0]!.product_count = 0;
      },
    ],
    [
      'a product without a child order ID',
      (logisticsInfo) => {
        const products = logisticsInfo[0]!.product_info as Array<Record<string, unknown>>;
        delete products[0]!.sku_order_id;
      },
    ],
    [
      'a duplicate product in one package',
      (logisticsInfo) => {
        const products = logisticsInfo[0]!.product_info as Array<Record<string, unknown>>;
        products.push({ ...products[0]! });
      },
    ],
    [
      'a duplicate delivery ID',
      (logisticsInfo) => {
        logisticsInfo[1]!.delivery_id = logisticsInfo[0]!.delivery_id;
      },
    ],
    [
      'the same product in multiple packages',
      (logisticsInfo) => {
        logisticsInfo[1]!.product_info = [{ sku_order_id: 'sku-order-1', product_count: 2 }];
      },
    ],
  ];

  it.each(invalidShipmentPackageCases)(
    'fails closed when orderDetail logistics_info contains %s',
    async (_label, mutate) => {
      const logisticsInfo = toDouyinLogisticsInfo(PREVIOUS_SHIPMENT_ROUTES);
      mutate(logisticsInfo);
      const detail = shipmentOrderDetail(PREVIOUS_SHIPMENT_ROUTES);
      detail.logistics_info = logisticsInfo;
      const adapter = new DouyinAdapter(
        CONFIG,
        async () =>
          new Response(JSON.stringify({ code: 10000, data: { shop_order_detail: detail } }), {
            status: 200,
          }),
      );

      await expect(adapter.getOrder('access-token', 'order-1')).rejects.toThrow();
    },
  );

  it('rejects package regrouping before calling logisticsEditByPack', async () => {
    const regroupedTargets: TestShipmentRoute[] = [
      {
        ...TARGET_SHIPMENT_ROUTES[0]!,
        items: [{ platformOrderItemId: 'sku-order-1', quantity: 1 }],
      },
      TARGET_SHIPMENT_ROUTES[1]!,
    ];
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') return orderDetailResponse(PREVIOUS_SHIPMENT_ROUTES);
      return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.replaceShipPackages(
        'access-token',
        replaceShipPackagesDto(PREVIOUS_SHIPMENT_ROUTES, regroupedTargets),
      ),
    ).rejects.toThrow();

    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
      ),
    ).toHaveLength(0);
  });

  it('rejects a pending replacement once the order is no longer shipped', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') {
        return orderDetailResponse(PREVIOUS_SHIPMENT_ROUTES, 5);
      }
      return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.replaceShipPackages('access-token', replaceShipPackagesDto()),
    ).rejects.toThrow();

    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
      ),
    ).toHaveLength(0);
  });

  it('replaces every previous route and verifies the final platform snapshot', async () => {
    const currentPreviousRoutes = PREVIOUS_SHIPMENT_ROUTES.map((route, index) => ({
      ...route,
      deliveryId: `platform-delivery-${index + 1}`,
    }));
    const verifiedTargetRoutes = TARGET_SHIPMENT_ROUTES.map((route, index) => ({
      ...route,
      deliveryId: `platform-delivery-${index + 1}`,
    }));
    let detailCallCount = 0;
    const fetcher = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') {
        detailCallCount += 1;
        return orderDetailResponse(
          detailCallCount === 1 ? currentPreviousRoutes : verifiedTargetRoutes,
        );
      }
      if (path === '/order/logisticsEditByPack') {
        return new Response(JSON.stringify({ code: 10000, msg: 'success' }), { status: 200 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher, () => 1_700_000_000_000);

    await adapter.replaceShipPackages('access-token', replaceShipPackagesDto());

    const editCalls = fetcher.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
    );
    expect(editCalls).toHaveLength(2);
    expect(editCalls.map(([input]) => new URL(String(input)).searchParams.get('method'))).toEqual([
      'order.logisticsEditByPack',
      'order.logisticsEditByPack',
    ]);
    expect(editCalls.map(([, init]) => init?.method)).toEqual(['POST', 'POST']);
    expect(editCalls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      {
        company_code: 'shunfeng',
        logistics_code: 'SF-NEW-001',
        order_id: 'order-1',
        pack_id: 'platform-delivery-1',
      },
      {
        company_code: 'yuantong',
        logistics_code: 'YT-NEW-002',
        order_id: 'order-1',
        pack_id: 'platform-delivery-2',
      },
    ]);
    expect(detailCallCount).toBe(2);
  });

  it('stops before editing the next package after execution ownership is lost', async () => {
    let detailCallCount = 0;
    let editCallCount = 0;
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') {
        detailCallCount += 1;
        return orderDetailResponse(PREVIOUS_SHIPMENT_ROUTES);
      }
      if (path === '/order/logisticsEditByPack') {
        editCallCount += 1;
        return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const guard = {
      assertOwned: vi.fn().mockImplementation(async () => {
        if (editCallCount > 0) throw new Error('execution ownership lost');
      }),
    };
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.replaceShipPackages('access-token', replaceShipPackagesDto(), guard),
    ).rejects.toThrow('execution ownership lost');

    expect(editCallCount).toBe(1);
    expect(detailCallCount).toBe(1);
  });

  it('safely retries a partial replacement by editing only the remaining previous route', async () => {
    const partiallyReplacedRoutes = [TARGET_SHIPMENT_ROUTES[0]!, PREVIOUS_SHIPMENT_ROUTES[1]!];
    let detailCallCount = 0;
    const fetcher = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') {
        detailCallCount += 1;
        return orderDetailResponse(
          detailCallCount === 1 ? partiallyReplacedRoutes : TARGET_SHIPMENT_ROUTES,
        );
      }
      if (path === '/order/logisticsEditByPack') {
        return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await adapter.replaceShipPackages('access-token', replaceShipPackagesDto());

    const editCalls = fetcher.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
    );
    expect(editCalls).toHaveLength(1);
    expect(JSON.parse(String(editCalls[0]![1]?.body))).toEqual({
      company_code: 'yuantong',
      logistics_code: 'YT-NEW-002',
      order_id: 'order-1',
      pack_id: 'delivery-2',
    });
  });

  it('treats a received order already at the target snapshot as an idempotent success', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') return orderDetailResponse(TARGET_SHIPMENT_ROUTES, 5);
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await adapter.replaceShipPackages('access-token', replaceShipPackagesDto());

    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
      ),
    ).toHaveLength(0);
  });

  it('accepts a received final snapshot when all requested replacements completed', async () => {
    let detailCallCount = 0;
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') {
        detailCallCount += 1;
        return detailCallCount === 1
          ? orderDetailResponse(PREVIOUS_SHIPMENT_ROUTES)
          : orderDetailResponse(TARGET_SHIPMENT_ROUTES, 5);
      }
      if (path === '/order/logisticsEditByPack') {
        return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.replaceShipPackages('access-token', replaceShipPackagesDto()),
    ).resolves.toBeUndefined();
    expect(detailCallCount).toBe(2);
  });

  it('fails closed without editing when a current package is neither previous nor target', async () => {
    const unexpectedRoutes: TestShipmentRoute[] = [
      PREVIOUS_SHIPMENT_ROUTES[0]!,
      { ...PREVIOUS_SHIPMENT_ROUTES[1]!, trackingNo: 'YT-UNKNOWN-002' },
    ];
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') return orderDetailResponse(unexpectedRoutes);
      if (path === '/order/logisticsEditByPack') {
        return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.replaceShipPackages('access-token', replaceShipPackagesDto()),
    ).rejects.toThrow();

    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
      ),
    ).toHaveLength(0);
  });

  it('fails when the final platform snapshot does not exactly match the target', async () => {
    const mismatchedFinalRoutes: TestShipmentRoute[] = [
      TARGET_SHIPMENT_ROUTES[0]!,
      { ...TARGET_SHIPMENT_ROUTES[1]!, trackingNo: 'YT-NOT-APPLIED' },
    ];
    let detailCallCount = 0;
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') {
        detailCallCount += 1;
        return orderDetailResponse(
          detailCallCount === 1 ? PREVIOUS_SHIPMENT_ROUTES : mismatchedFinalRoutes,
        );
      }
      if (path === '/order/logisticsEditByPack') {
        return new Response(JSON.stringify({ code: 10000 }), { status: 200 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    await expect(
      adapter.replaceShipPackages('access-token', replaceShipPackagesDto()),
    ).rejects.toThrow();

    expect(
      fetcher.mock.calls.filter(
        ([input]) => new URL(String(input)).pathname === '/order/logisticsEditByPack',
      ),
    ).toHaveLength(2);
    expect(detailCallCount).toBe(2);
  });

  it('sanitizes logisticsEditByPack API failures', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/order/logisticsCompanyList') return logisticsCompanyListResponse();
      if (path === '/order/orderDetail') return orderDetailResponse(PREVIOUS_SHIPMENT_ROUTES);
      if (path === '/order/logisticsEditByPack') {
        return new Response(
          JSON.stringify({
            code: 20001,
            sub_msg: 'permission denied',
            secret: 'do-not-log-this-response',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected path ${path}`);
    });
    const adapter = new DouyinAdapter(CONFIG, fetcher);

    const error = await adapter.replaceShipPackages('access-token', replaceShipPackagesDto()).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('permission denied');
    expect((error as Error).message).not.toContain('do-not-log-this-response');
  });

  it('maps API failures without exposing the full response', async () => {
    const adapter = new DouyinAdapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({ code: 20001, sub_msg: 'permission denied', secret: 'do-not-log' }),
          { status: 200 },
        ),
    );

    await expect(adapter.listOrders('token', {})).rejects.toThrow(
      'Douyin order list failed: permission denied',
    );
  });
});
