import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CrawlerError } from '../adapter';
import { OpenApi1688Adapter } from './openapi-1688';

const CONFIG = {
  appKey: '1000000',
  appSecret: 'app-secret',
  accessToken: 'access-token',
};

describe('OpenApi1688Adapter', () => {
  it('signs cross.productInfo.get and maps official product fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        success: true,
        productInfo: {
          productID: 573741401425,
          status: 'published',
          subject: '纯棉短袖T恤',
          categoryID: 1048182,
          categoryName: '女装',
          supplierUserId: 'supplier-42',
          bookedCount: '1.5万+',
          crossBorderOffer: true,
          productImage: {
            images: ['img/ibank/main.jpg', '["https://cbu01.alicdn.com/img/ibank/second.jpg"]'],
          },
          productAttribute: [
            { attributeName: '材质', value: '棉' },
            { attributeName: '风格', value: '通勤' },
          ],
          productSkuInfos: [
            {
              skuId: 111,
              specId: 'spec-red-m',
              amountOnSale: 8,
              price: 15,
              consignPrice: 12.5,
              attributes: [
                {
                  attributeDisplayName: '颜色',
                  attributeValue: '红色',
                  skuImageUrl: 'img/ibank/red.jpg',
                },
                { attributeDisplayName: '尺码', attributeValue: 'M' },
              ],
            },
            {
              skuId: 112,
              specId: 'spec-blue-l',
              amountOnSale: 0,
              consignPrice: 14,
              attributes: [
                { attributeDisplayName: '颜色', attributeValue: '蓝色' },
                { attributeDisplayName: '尺码', attributeValue: 'L' },
              ],
            },
          ],
          productSaleInfo: { consignPrice: 20 },
          productBizGroupInfos: [
            { support: true, code: 'isConsignMarketOffer', description: '1688代销产品' },
          ],
          description: '<p>商品详情</p><img src="//cbu01.alicdn.com/img/ibank/detail.jpg">',
        },
      }),
    );
    const adapter = new OpenApi1688Adapter(CONFIG, fetcher);

    const product = await adapter.fetchProduct('573741401425');

    expect(product).toEqual(
      expect.objectContaining({
        productId1688: '573741401425',
        supplierId: 'supplier-42',
        title: '纯棉短袖T恤',
        price: 12.5,
        priceMin: 12.5,
        priceMax: 14,
        mainImage: 'https://cbu01.alicdn.com/img/ibank/main.jpg',
        categoryPath: '女装',
        categoryL1: '女装',
        monthlySold: 15_000,
        isCrossBorder: true,
        isOnePieceDrop: true,
        attributes: {
          材质: '棉',
          风格: '通勤',
          alibaba1688CategoryId: '1048182',
        },
      }),
    );
    expect(product?.detailImages).toContain('https://cbu01.alicdn.com/img/ibank/detail.jpg');
    expect(product?.skuList).toEqual([
      {
        skuId: 'spec-red-m',
        specName: '颜色:红色;尺码:M',
        price: 12.5,
        stock: 8,
        attributes: { 颜色: '红色', 尺码: 'M' },
        image: 'https://cbu01.alicdn.com/img/ibank/red.jpg',
      },
      {
        skuId: 'spec-blue-l',
        specName: '颜色:蓝色;尺码:L',
        price: 14,
        stock: 0,
        attributes: { 颜色: '蓝色', 尺码: 'L' },
      },
    ]);

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      'https://gw.open.1688.com/openapi/param2/1/com.alibaba.fenxiao/cross.productInfo.get/1000000',
    );
    const body = new URLSearchParams(String(init.body));
    expect(body.get('access_token')).toBe('access-token');
    expect(body.get('offerId')).toBe('573741401425');
    const urlPath = 'param2/1/com.alibaba.fenxiao/cross.productInfo.get/1000000';
    const expectedSignature = createHmac('sha1', 'app-secret')
      .update(`${urlPath}access_tokenaccess-tokenofferId573741401425`)
      .digest('hex')
      .toUpperCase();
    expect(body.get('_aop_signature')).toBe(expectedSignature);
  });

  it('searches official cross-border offers across pages and deduplicates IDs', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          result: {
            success: true,
            code: 'SUCCESS',
            result: [{ offerId: 101 }, { offerId: 101 }, { offerId: 102 }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          result: { success: true, code: 'SUCCESS', result: [{ offerId: 103 }] },
        }),
      );
    const adapter = new OpenApi1688Adapter(
      { ...CONFIG, searchFilters: ['shipIn48Hours', 'jxhy'] },
      fetcher,
    );

    await expect(adapter.searchByCategory('女装', 3)).resolves.toEqual(['101', '102', '103']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = new URLSearchParams(String(fetcher.mock.calls[0]![1].body));
    expect(firstBody.get('scenario')).toBe('all');
    expect(JSON.parse(firstBody.get('param') ?? '{}')).toEqual({
      categoryIds: [],
      filter: ['shipIn48Hours', 'jxhy'],
      keywords: '女装',
      pageNum: 1,
      pageSize: 3,
      priceEnd: '99999999',
      priceStart: '0.01',
      quantityBegin: 1,
      sortOrder: 'desc',
      sortType: 'va_rmdarkgmv30rt',
    });
    const secondBody = new URLSearchParams(String(fetcher.mock.calls[1]![1].body));
    expect(JSON.parse(secondBody.get('param') ?? '{}')).toMatchObject({ pageNum: 2 });
  });

  it('returns null when the requested product is no longer published', async () => {
    const adapter = new OpenApi1688Adapter(
      CONFIG,
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          productInfo: {
            productID: 573741401425,
            status: 'expired',
            subject: '已下架商品',
          },
        }),
      ),
    );

    await expect(adapter.fetchProduct('573741401425')).resolves.toBeNull();

    const missing = new OpenApi1688Adapter(
      CONFIG,
      vi.fn().mockResolvedValue(jsonResponse({ success: false, errorCode: 'OFFER_NOT_EXIST' })),
    );
    await expect(missing.fetchProduct('573741401425')).resolves.toBeNull();
  });

  it('uses the lowest quantity price for products without SKU-level prices', async () => {
    const adapter = new OpenApi1688Adapter(
      CONFIG,
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          productInfo: {
            productID: 573741401425,
            status: 'published',
            subject: '无规格商品',
            productSaleInfo: {
              priceRanges: [
                { startQuantity: 1, price: 40 },
                { startQuantity: 100, price: 35 },
              ],
            },
          },
        }),
      ),
    );

    await expect(adapter.fetchProduct('573741401425')).resolves.toMatchObject({
      price: 35,
      priceMin: 35,
      priceMax: 35,
    });
  });

  it('maps HTTP and platform errors to retry-safe crawler errors', async () => {
    const rateLimited = new OpenApi1688Adapter(
      CONFIG,
      vi.fn().mockResolvedValue(new Response('', { status: 429 })),
    );
    await expect(rateLimited.fetchProduct('573741401425')).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      httpStatus: 429,
    });

    const unauthorized = new OpenApi1688Adapter(
      CONFIG,
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ success: false, errorCode: 'ACCESS_TOKEN_EXPIRED' })),
    );
    await expect(unauthorized.fetchProduct('573741401425')).rejects.toMatchObject({
      code: 'auth',
      retryable: false,
    });
  });

  it('fails closed on mismatched product IDs and unsupported search filters', async () => {
    const adapter = new OpenApi1688Adapter(
      CONFIG,
      vi.fn().mockResolvedValue(
        jsonResponse({
          success: true,
          productInfo: {
            productID: 999,
            status: 'published',
            subject: '错误商品',
          },
        }),
      ),
    );
    await expect(adapter.fetchProduct('573741401425')).rejects.toMatchObject({ code: 'parse' });

    expect(
      () =>
        new OpenApi1688Adapter({
          ...CONFIG,
          searchFilters: ['unsupported' as never],
        }),
    ).toThrow(CrawlerError);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
