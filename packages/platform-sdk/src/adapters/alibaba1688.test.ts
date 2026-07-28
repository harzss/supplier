import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterConfig } from '../types';
import { Alibaba1688Adapter } from './alibaba1688';

const CONFIG: AdapterConfig = {
  appKey: '1000000',
  appSecret: 'test123',
  redirectUri: 'https://supplier.example.com/api/shops/oauth/alibaba_1688/callback',
};

class TestAlibaba1688Adapter extends Alibaba1688Adapter {
  signForTest(urlPath: string, params: Record<string, unknown>): string {
    return this.sign({ urlPath, ...params });
  }

  requestForTest<T extends { success?: boolean; errorCode?: string; code?: string }>(
    accessToken: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return this.requestApi<T>(
      'com.alibaba.trade',
      'alibaba.trade.fastCreateOrder',
      'order creation',
      accessToken,
      params,
    );
  }
}

describe('Alibaba1688Adapter', () => {
  it('builds the official web OAuth URL without a client-side signature', () => {
    const url = new URL(new Alibaba1688Adapter(CONFIG).buildAuthUrl('state-123'));

    expect(url.origin + url.pathname).toBe('https://auth.1688.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '1000000',
      redirect_uri: CONFIG.redirectUri,
      site: '1688',
      state: 'state-123',
    });
    expect(url.searchParams.has('_aop_signature')).toBe(false);
  });

  it('matches the official HMAC-SHA1 API signing example', () => {
    const adapter = new TestAlibaba1688Adapter(CONFIG);

    expect(adapter.signForTest('param2/1/system/currentTime/1000000', { b: 2, a: 1 })).toBe(
      '33E54F4F7B989E3E0E912D3FBD2F1A03CA7CCE88',
    );
  });

  it('exchanges a one-time code over HTTPS POST without putting credentials in the URL', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: '36000',
            memberId: 'member-1',
            resource_owner: 'buyer-login',
          }),
          { status: 200 },
        ),
    );
    const now = 1_700_000_000_000;
    const adapter = new Alibaba1688Adapter(CONFIG, fetcher, () => now);

    const token = await adapter.exchangeToken('one-time-code');

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body));
    expect(url.origin + url.pathname).toBe(
      'https://gw.open.1688.com/openapi/http/1/system.oauth2/getToken/1000000',
    );
    expect(url.search).toBe('');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    expect(Object.fromEntries(body)).toEqual({
      client_id: '1000000',
      client_secret: 'test123',
      code: 'one-time-code',
      grant_type: 'authorization_code',
      need_refresh_token: 'true',
      redirect_uri: CONFIG.redirectUri,
    });
    expect(token).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(now + 36_000_000),
      platformShopId: 'member-1',
      shopName: 'buyer-login',
    });
  });

  it('refreshes an access token through the unsigned param2 token endpoint', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 36000,
            memberId: 'member-1',
          }),
          { status: 200 },
        ),
    );
    const adapter = new Alibaba1688Adapter(CONFIG, fetcher);

    await adapter.refreshToken('old-refresh-token');

    const [input, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe(
      '/openapi/param2/1/system.oauth2/getToken/1000000',
    );
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      client_id: '1000000',
      client_secret: 'test123',
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
    });
  });

  it('signs every form parameter and posts only to the fixed OpenAPI origin', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: { orderId: '1688-order-1' } }), {
          status: 200,
        }),
    );
    const adapter = new TestAlibaba1688Adapter(CONFIG, fetcher);
    const addressParam = {
      provinceText: '浙江省',
      cityText: '杭州市',
      areaText: '滨江区',
      address: '网商路699号',
      fullName: '张三',
      mobile: '13988888888',
    };
    const cargoParamList = [{ offerId: 554456348334, quantity: 2, specId: 'spec-1' }];

    const result = await adapter.requestForTest<{
      success: boolean;
      result: { orderId: string };
    }>('access-token', { flow: 'general', addressParam, cargoParamList });

    const [input, init] = fetcher.mock.calls[0]!;
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body));
    const urlPath = 'param2/1/com.alibaba.trade/alibaba.trade.fastCreateOrder/1000000';
    const serializedAddress =
      '{"address":"网商路699号","areaText":"滨江区","cityText":"杭州市","fullName":"张三","mobile":"13988888888","provinceText":"浙江省"}';
    const serializedCargo = '[{"offerId":554456348334,"quantity":2,"specId":"spec-1"}]';
    const signData =
      `${urlPath}access_tokenaccess-token` +
      `addressParam${serializedAddress}` +
      `cargoParamList${serializedCargo}` +
      'flowgeneral';
    const expectedSign = createHmac('sha1', 'test123').update(signData).digest('hex').toUpperCase();

    expect(url.origin).toBe('https://gw.open.1688.com');
    expect(url.pathname).toBe(`/openapi/${urlPath}`);
    expect(url.search).toBe('');
    expect(Object.fromEntries(body)).toEqual({
      _aop_signature: expectedSign,
      access_token: 'access-token',
      addressParam: serializedAddress,
      cargoParamList: serializedCargo,
      flow: 'general',
    });
    expect(result.result.orderId).toBe('1688-order-1');
  });

  it('creates an idempotent purchase order with validated address and merged cargo', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, result: { orderId: 58218860983545944 } }), {
          status: 200,
        }),
    );
    const adapter = new Alibaba1688Adapter(CONFIG, fetcher);

    const result = await adapter.createOrder('access-token', {
      flow: 'general',
      address: {
        provinceText: '浙江省',
        cityText: '杭州市',
        areaText: '滨江区',
        townText: '长河街道',
        address: '网商路699号',
        fullName: '张三',
        mobile: '13988888888',
        postCode: '310000',
      },
      cargo: [
        { offerId: '554456348334', specId: 'spec-1', quantity: 2 },
        { offerId: '554456348334', specId: 'spec-1', quantity: 3 },
      ],
      outOrderId: 'supplier-order-42',
      fenxiaoChannel: 'douyin',
    });

    const [, init] = fetcher.mock.calls[0]!;
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('flow')).toBe('general');
    expect(body.get('outOrderId')).toBe('supplier-order-42');
    expect(body.get('fenxiaoChannel')).toBe('douyin');
    expect(JSON.parse(body.get('cargoParamList')!)).toEqual([
      { offerId: '554456348334', quantity: 5, specId: 'spec-1' },
    ]);
    expect(JSON.parse(body.get('addressParam')!)).toMatchObject({
      provinceText: '浙江省',
      cityText: '杭州市',
      areaText: '滨江区',
      address: '网商路699号',
      fullName: '张三',
      mobile: '13988888888',
    });
    expect(result).toEqual({ orderId: '58218860983545944' });
  });

  it('recovers a buyer order by the official external order ID query', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            totalRecord: 1,
            result: [
              {
                baseInfo: {
                  idOfStr: '58218860983545941',
                  status: 'waitbuyerpay',
                  totalAmount: 6.15,
                },
                productItems: [
                  {
                    productID: 558700975520,
                    subItemIDString: '58218860985545941',
                    specId: '6ff6071792c8ab520b9b867c61b990bd',
                    quantity: 2,
                    status: 'waitbuyerpay',
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const adapter = new Alibaba1688Adapter(CONFIG, fetcher);

    await expect(
      adapter.findBuyerOrderByOutOrderId('access-token', 'supplier-order-42'),
    ).resolves.toMatchObject({
      orderId: '58218860983545941',
      status: 'waitbuyerpay',
      totalAmount: 6.15,
    });

    const [url, init] = fetcher.mock.calls[0]!;
    const body = new URLSearchParams(String(init?.body));
    expect(String(url)).toContain('alibaba.trade.getBuyerOrderList');
    expect(body.get('outOrderId')).toBe('supplier-order-42');
    expect(body.get('page')).toBe('1');
    expect(body.get('pageSize')).toBe('2');
  });

  it('returns null when no buyer order has the external order ID', async () => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () => new Response(JSON.stringify({ totalRecord: 0, result: [] }), { status: 200 }),
    );

    await expect(
      adapter.findBuyerOrderByOutOrderId('access-token', 'supplier-order-42'),
    ).resolves.toBeNull();
  });

  it('rejects ambiguous external order ID recovery results', async () => {
    const order = {
      baseInfo: { idOfStr: '58218860983545941', status: 'waitbuyerpay' },
      productItems: [],
    };
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ totalRecord: 2, result: [order, order] }), { status: 200 }),
    );

    await expect(
      adapter.findBuyerOrderByOutOrderId('access-token', 'supplier-order-42'),
    ).rejects.toThrow('recovery query returned an invalid response');
  });

  it('maps buyer order status and item spec IDs from the official response shape', async () => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              baseInfo: {
                idOfStr: '58218860983545941',
                status: 'waitsellersend',
                totalAmount: 6.15,
              },
              productItems: [
                {
                  productID: 558700975520,
                  subItemIDString: '58218860985545941',
                  specId: '6ff6071792c8ab520b9b867c61b990bd',
                  quantity: 2,
                  status: 'waitsellersend',
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getBuyerOrder('access-token', '58218860983545941')).resolves.toEqual({
      orderId: '58218860983545941',
      status: 'waitsellersend',
      totalAmount: 6.15,
      items: [
        {
          offerId: '558700975520',
          specId: '6ff6071792c8ab520b9b867c61b990bd',
          subItemId: '58218860985545941',
          quantity: 2,
          status: 'waitsellersend',
        },
      ],
    });
  });

  it.each([
    [
      'missing product items',
      { baseInfo: { idOfStr: '58218860983545941', status: 'waitsellersend' } },
    ],
    [
      'an empty product item list',
      {
        baseInfo: { idOfStr: '58218860983545941', status: 'waitsellersend' },
        productItems: [],
      },
    ],
    [
      'a malformed total amount',
      {
        baseInfo: {
          idOfStr: '58218860983545941',
          status: 'waitsellersend',
          totalAmount: 'invalid',
        },
        productItems: [
          {
            productID: 558700975520,
            subItemIDString: '58218860985545941',
            quantity: 1,
            status: 'waitsellersend',
          },
        ],
      },
    ],
    [
      'a negative total amount',
      {
        baseInfo: {
          idOfStr: '58218860983545941',
          status: 'waitsellersend',
          totalAmount: -1,
        },
        productItems: [
          {
            productID: 558700975520,
            subItemIDString: '58218860985545941',
            quantity: 1,
            status: 'waitsellersend',
          },
        ],
      },
    ],
    [
      'a fractional product quantity',
      {
        baseInfo: { idOfStr: '58218860983545941', status: 'waitsellersend' },
        productItems: [
          {
            productID: 558700975520,
            subItemIDString: '58218860985545941',
            quantity: 1.5,
            status: 'waitsellersend',
          },
        ],
      },
    ],
    [
      'duplicate product item IDs',
      {
        baseInfo: { idOfStr: '58218860983545941', status: 'waitsellersend' },
        productItems: [1, 2].map(() => ({
          productID: 558700975520,
          subItemIDString: '58218860985545941',
          quantity: 1,
          status: 'waitsellersend',
        })),
      },
    ],
    [
      'a missing product item status',
      {
        baseInfo: { idOfStr: '58218860983545941', status: 'waitsellersend' },
        productItems: [
          {
            productID: 558700975520,
            subItemIDString: '58218860985545941',
            quantity: 1,
          },
        ],
      },
    ],
  ])('rejects buyer order responses with %s', async (_label, result) => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(JSON.stringify({ success: true, result }), {
          status: 200,
        }),
    );

    await expect(adapter.getBuyerOrder('access-token', '58218860983545941')).rejects.toThrow(
      'Alibaba 1688 buyer order query returned an invalid response',
    );
  });

  it('maps buyer-view logistics without exposing receiver or sender details', async () => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                logisticsId: 'BX111841674232006',
                orderEntryIds: '58218860985545941,58218860986545941',
                status: 'SIGN',
                company: { name: '顺丰速运' },
                receiver: { receiverMobile: '13800138000' },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const result = await adapter.getLogisticsInfos('access-token', '58218860983545941');

    expect(result).toEqual([
      {
        trackingNo: 'BX111841674232006',
        carrier: '顺丰速运',
        status: 'SIGN',
        orderEntryIds: ['58218860985545941', '58218860986545941'],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('13800138000');
  });

  it('rejects duplicate tracking numbers in one logistics snapshot', async () => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
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
                orderEntryIds: 'entry-2',
                company: { name: '顺丰速运' },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getLogisticsInfos('access-token', '58218860983545941')).rejects.toThrow(
      'Alibaba 1688 logistics query returned an invalid response',
    );
  });

  it.each([
    ['a malformed company', { company: ['顺丰速运'] }],
    ['a malformed carrier name', { company: { name: { text: '顺丰速运' } } }],
    ['a malformed status', { company: { name: '顺丰速运' }, status: { code: 'ACCEPT' } }],
    ['an overlong carrier name', { company: { name: 'x'.repeat(65) } }],
    ['an overlong status', { company: { name: '顺丰速运' }, status: 'x'.repeat(33) }],
  ])('rejects logistics snapshots with %s', async (_label, fields) => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                logisticsId: 'SF111',
                orderEntryIds: 'entry-1',
                ...fields,
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getLogisticsInfos('access-token', '58218860983545941')).rejects.toThrow(
      'Alibaba 1688 logistics query returned an invalid response',
    );
  });

  it.each([
    ['an object value', { id: 'entry-1' }],
    ['a malformed array item', ['entry-1', { id: 'entry-2' }]],
    ['duplicate IDs', 'entry-1,entry-1'],
    ['an overlong ID', 'x'.repeat(129)],
  ])('rejects logistics snapshots with %s in orderEntryIds', async (_label, orderEntryIds) => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                logisticsId: 'SF111',
                orderEntryIds,
                company: { name: '顺丰速运' },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getLogisticsInfos('access-token', '58218860983545941')).rejects.toThrow(
      'Alibaba 1688 logistics query returned an invalid response',
    );
  });

  it('preserves a genuinely missing orderEntryIds field for single-package fallback', async () => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                logisticsId: 'SF111',
                company: { name: '顺丰速运' },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(adapter.getLogisticsInfos('access-token', '58218860983545941')).resolves.toEqual([
      {
        trackingNo: 'SF111',
        carrier: '顺丰速运',
        status: null,
        orderEntryIds: [],
      },
    ]);
  });

  it('rejects unsafe order data before calling the API', async () => {
    const fetcher = vi.fn();
    const adapter = new Alibaba1688Adapter(CONFIG, fetcher);

    await expect(
      adapter.createOrder('access-token', {
        flow: 'general',
        address: {
          provinceText: '浙江省',
          cityText: '杭州市',
          areaText: '滨江区',
          address: '网商路699号',
          fullName: '张三',
        },
        cargo: [{ offerId: '554456348334', quantity: 1 }],
        outOrderId: 'supplier-order-42',
      }),
    ).rejects.toThrow('receiver mobile or phone is required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps API failures without exposing response messages or credentials', async () => {
    const adapter = new TestAlibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            errorCode: '400',
            message: 'bad access-token and client secret test123',
          }),
          { status: 200 },
        ),
    );

    let error: Error | undefined;
    try {
      await adapter.requestForTest('access-token', { flow: 'general' });
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.message).toBe('Alibaba 1688 order creation failed (code 400)');
    expect(error?.message).not.toMatch(/access-token|test123/);
  });

  it('rejects invalid token responses without exposing their payload', async () => {
    const adapter = new Alibaba1688Adapter(
      CONFIG,
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'expired one-time-code and secret test123',
          }),
          { status: 200 },
        ),
    );

    let error: Error | undefined;
    try {
      await adapter.exchangeToken('one-time-code');
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.message).toBe('Alibaba 1688 token exchange failed (code invalid_grant)');
    expect(error?.message).not.toMatch(/one-time-code|test123/);
  });

  it('rejects malformed responses, reserved parameters, and missing tokens before unsafe use', async () => {
    const fetcher = vi.fn();
    const adapter = new TestAlibaba1688Adapter(CONFIG, fetcher);

    await expect(adapter.requestForTest('', { flow: 'general' })).rejects.toThrow(
      'Alibaba 1688 access token is required',
    );
    await expect(
      adapter.requestForTest('access-token', { _aop_signature: 'attacker-value' }),
    ).rejects.toThrow('Alibaba 1688 API parameter name is invalid');
    expect(fetcher).not.toHaveBeenCalled();

    const malformed = new Alibaba1688Adapter(
      CONFIG,
      async () => new Response('[]', { status: 200 }),
    );
    await expect(malformed.exchangeToken('one-time-code')).rejects.toThrow(
      'Alibaba 1688 token exchange returned an invalid response',
    );
  });
});
