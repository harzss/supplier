import { createHmac } from 'node:crypto';
import type { SourceAdapter } from '../adapter';
import { CrawlerError } from '../adapter';
import type { CrawledProduct, CrawledSku } from '../types';

type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OpenApi1688SearchFilter =
  | 'shipIn48Hours'
  | 'freeExchange7days'
  | 'powerMerchant'
  | 'crossPotential'
  | 'ttpft'
  | 'jxhy';

/** 1688 跨境代采解决方案配置。应用必须先订购对应方案并取得买家 OAuth Token。 */
export interface OpenApi1688Config {
  appKey: string;
  appSecret: string;
  accessToken: string;
  baseUrl?: string;
  scenario?: string;
  searchFilters?: OpenApi1688SearchFilter[];
}

interface ApiEnvelope {
  success?: boolean | string;
  errorCode?: string;
  code?: string;
  result?: unknown;
}

const DEFAULT_BASE_URL = 'https://gw.open.1688.com/openapi';
const IMAGE_BASE_URL = 'https://cbu01.alicdn.com/';
const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_PAGE_SIZE = 50;
const SEARCH_MAX_PAGES = 10;
const MAX_PRODUCT_ID_LENGTH = 32;
const MAX_SUPPLIER_ID_LENGTH = 32;
const MAX_PRODUCT_TITLE_LENGTH = 255;
const MAX_CATEGORY_L1_LENGTH = 64;
const MAX_MAIN_IMAGE_LENGTH = 512;
const MAX_DETAIL_IMAGES = 50;
const MAX_PRODUCT_ATTRIBUTES = 100;
const MAX_PRODUCT_ATTRIBUTE_NAME_LENGTH = 128;
const MAX_PRODUCT_ATTRIBUTE_VALUE_LENGTH = 1_024;
const MAX_SKUS = 100;
const MAX_SKU_ID_LENGTH = 128;
const MAX_SKU_ATTRIBUTES = 10;
const MAX_SKU_ATTRIBUTE_NAME_LENGTH = 64;
const MAX_SKU_ATTRIBUTE_VALUE_LENGTH = 255;
const MAX_SOURCE_PRICE = 99_999_999.99;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const SEARCH_FILTERS = new Set<OpenApi1688SearchFilter>([
  'shipIn48Hours',
  'freeExchange7days',
  'powerMerchant',
  'crossPotential',
  'ttpft',
  'jxhy',
]);

/**
 * 1688 买家货源适配器。
 *
 * 官方跨境代采方案约定：
 * - `cross.keywords.search` 用于买家货源搜索；
 * - `cross.productInfo.get` 用于买家查看商品详情；
 * - `alibaba.product.get` 只能查询授权卖家自己的商品，不能用于通用货源采集。
 */
export class OpenApi1688Adapter implements SourceAdapter {
  readonly name = '1688-openapi';
  private readonly baseUrl: string;
  private readonly scenario: string;
  private readonly searchFilters: OpenApi1688SearchFilter[];
  private readonly appKey: string;
  private readonly appSecret: string;
  private readonly accessToken: string;

  constructor(
    config: OpenApi1688Config,
    private readonly fetcher: HttpFetch = fetch,
  ) {
    this.appKey = config.appKey.trim();
    this.appSecret = config.appSecret;
    this.accessToken = config.accessToken.trim();
    this.baseUrl = validateBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.scenario = boundedToken(config.scenario ?? 'all', 64, 'search scenario');
    this.searchFilters = validateSearchFilters(config.searchFilters ?? []);
    this.assertConfig();
  }

  async fetchProduct(productId1688: string): Promise<CrawledProduct | null> {
    const requestedId = positiveId(productId1688, 'product ID');
    let payload: ApiEnvelope & Record<string, unknown>;
    try {
      payload = await this.request<ApiEnvelope>(
        'com.alibaba.fenxiao',
        'cross.productInfo.get',
        'product detail',
        { offerId: requestedId },
      );
    } catch (error) {
      if (error instanceof CrawlerError && error.code === 'not_found') return null;
      throw error;
    }
    if (isApiFailure(payload)) {
      const error = apiError('product detail', payload);
      if (error.code === 'not_found') return null;
      throw error;
    }

    const productInfo = recordValue(payload.productInfo);
    if (!productInfo) {
      if (payload.errorCode || payload.code) throw apiError('product detail', payload);
      throw new CrawlerError('Alibaba 1688 product detail returned an invalid response', 'parse');
    }
    return mapProduct(productInfo, payload, requestedId);
  }

  async searchByCategory(categoryL1: string, limit: number): Promise<string[]> {
    const keywords = boundedText(categoryL1, 128, 'search keywords');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES) {
      throw new CrawlerError(
        `Alibaba 1688 search limit must be between 1 and ${SEARCH_PAGE_SIZE * SEARCH_MAX_PAGES}`,
        'parse',
      );
    }

    const ids = new Set<string>();
    const pageSize = Math.min(SEARCH_PAGE_SIZE, limit);
    for (let pageNum = 1; pageNum <= SEARCH_MAX_PAGES && ids.size < limit; pageNum++) {
      const payload = await this.request<ApiEnvelope>(
        'com.alibaba.fenxiao',
        'cross.keywords.search',
        'keyword search',
        {
          scenario: this.scenario,
          param: {
            keywords,
            categoryIds: [],
            quantityBegin: 1,
            priceStart: '0.01',
            priceEnd: '99999999',
            sortType: 'va_rmdarkgmv30rt',
            sortOrder: 'desc',
            filter: this.searchFilters,
            pageSize,
            pageNum,
          },
        },
      );
      if (isApiFailure(payload)) throw apiError('keyword search', payload);
      const page = recordValue(payload.result);
      if (!page || isApiFailure(page)) {
        if (page) throw apiError('keyword search', page);
        throw new CrawlerError('Alibaba 1688 keyword search returned an invalid response', 'parse');
      }
      const offers = arrayValue(page.result);
      let validOffers = 0;
      for (const value of offers) {
        const offer = recordValue(value);
        const offerId = optionalPositiveId(offer?.offerId);
        if (offerId) {
          ids.add(offerId);
          validOffers++;
        }
        if (ids.size === limit) break;
      }
      if (offers.length > 0 && validOffers === 0) {
        throw new CrawlerError('Alibaba 1688 keyword search contains no valid offer IDs', 'parse');
      }
      if (offers.length < pageSize) break;
    }
    return [...ids];
  }

  private async request<T extends ApiEnvelope>(
    namespace: string,
    method: string,
    operation: string,
    params: Record<string, unknown>,
  ): Promise<T & Record<string, unknown>> {
    const urlPath = `param2/1/${namespace}/${method}/${this.appKey}`;
    const requestParams: Record<string, unknown> = {
      ...params,
      access_token: this.accessToken,
    };
    requestParams._aop_signature = this.sign(urlPath, requestParams);
    const body = new URLSearchParams(
      Object.keys(requestParams)
        .sort()
        .map((key) => [key, serializeParam(requestParams[key])]),
    );

    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/${urlPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CrawlerError(`Alibaba 1688 ${operation} request failed`, 'network');
    }
    if (!response.ok) throw httpError(operation, response.status);

    try {
      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('invalid payload');
      }
      return payload as T & Record<string, unknown>;
    } catch {
      throw new CrawlerError(`Alibaba 1688 ${operation} returned an invalid response`, 'parse');
    }
  }

  private sign(urlPath: string, params: Record<string, unknown>): string {
    const serialized = Object.keys(params)
      .filter(
        (key) => key !== '_aop_signature' && params[key] !== undefined && params[key] !== null,
      )
      .sort()
      .map((key) => `${key}${serializeParam(params[key])}`)
      .join('');
    return createHmac('sha1', this.appSecret)
      .update(`${urlPath}${serialized}`)
      .digest('hex')
      .toUpperCase();
  }

  private assertConfig(): void {
    if (!/^[A-Za-z0-9_-]+$/.test(this.appKey)) {
      throw new CrawlerError('Alibaba 1688 AppKey is invalid', 'auth');
    }
    if (!this.appSecret || !this.accessToken) {
      throw new CrawlerError('Alibaba 1688 credentials are incomplete', 'auth');
    }
  }
}

function mapProduct(
  product: Record<string, unknown>,
  envelope: Record<string, unknown>,
  requestedId: string,
): CrawledProduct | null {
  const productId1688 = optionalPositiveId(product.productID ?? product.offerId);
  if (!productId1688 || productId1688 !== requestedId) {
    throw new CrawlerError('Alibaba 1688 product detail returned a mismatched product ID', 'parse');
  }
  const status = stringValue(product.status);
  if (status && status !== 'published') return null;
  const title = boundedText(product.subject, MAX_PRODUCT_TITLE_LENGTH, 'product title');

  const rawSkuValue = product.productSkuInfos ?? product.skuInfos;
  if (rawSkuValue !== undefined && rawSkuValue !== null && !Array.isArray(rawSkuValue)) {
    throw new CrawlerError('Alibaba 1688 product detail contains invalid SKU data', 'parse');
  }
  const rawSkus = arrayValue(rawSkuValue);
  if (rawSkus.length > MAX_SKUS) {
    throw new CrawlerError(
      `Alibaba 1688 product detail contains more than ${MAX_SKUS} SKUs`,
      'parse',
    );
  }
  const skuList = rawSkus.map(mapSku);
  if (new Set(skuList.map((sku) => sku.skuId)).size !== skuList.length) {
    throw new CrawlerError('Alibaba 1688 product detail contains duplicate SKU IDs', 'parse');
  }

  const saleInfo = recordValue(product.productSaleInfo ?? product.saleInfo);
  const prices = skuList.map((sku) => sku.price);
  if (!prices.length) {
    const salePrice =
      firstPositiveNumber([saleInfo?.consignPrice, saleInfo?.jxhyPrice, saleInfo?.pftPrice]) ??
      minimumPositiveNumber(
        arrayValue(saleInfo?.priceRanges).map((value) => recordValue(value)?.price),
      ) ??
      firstPositiveNumber([saleInfo?.retailprice, product.referencePrice]);
    if (salePrice) prices.push(salePrice);
  }
  if (!prices.length) {
    throw new CrawlerError('Alibaba 1688 product detail contains no usable price', 'parse');
  }

  const productImage = recordValue(product.productImage ?? product.image);
  const mainImages = normalizeImages(productImage?.images);
  const mainImage = optionalBoundedText(mainImages[0], MAX_MAIN_IMAGE_LENGTH, 'main image URL');
  const intelligentInfo = recordValue(product.intelligentInfo);
  const detailImages = unique([
    ...normalizeImages(intelligentInfo?.descriptionImages),
    ...extractHtmlImages(stringValue(product.description)),
  ]).filter((url) => !mainImages.includes(url));
  if (detailImages.length > MAX_DETAIL_IMAGES) {
    throw new CrawlerError(
      `Alibaba 1688 product detail contains more than ${MAX_DETAIL_IMAGES} detail images`,
      'parse',
    );
  }

  const categoryName = optionalBoundedText(
    product.categoryName,
    MAX_CATEGORY_L1_LENGTH,
    'category name',
  );
  const categoryId = optionalPositiveId(product.categoryID);
  const attributes = mapAttributes(product.productAttribute ?? product.attributes);
  if (categoryId) {
    if (
      attributes.alibaba1688CategoryId === undefined &&
      Object.keys(attributes).length >= MAX_PRODUCT_ATTRIBUTES
    ) {
      throw new CrawlerError(
        `Alibaba 1688 product detail contains more than ${MAX_PRODUCT_ATTRIBUTES} attributes`,
        'parse',
      );
    }
    attributes.alibaba1688CategoryId = categoryId;
  }

  const rawGroups = [
    ...arrayValue(product.productBizGroupInfos ?? product.bizGroupInfos),
    ...arrayValue(envelope.bizGroupInfos),
  ];
  const isConsignOffer = rawGroups.some((value) => {
    const group = recordValue(value);
    return group?.support === true && stringValue(group.code) === 'isConsignMarketOffer';
  });
  const hasConsignPrice =
    positiveNumber(saleInfo?.consignPrice) !== null ||
    rawSkus.some((value) => positiveNumber(recordValue(value)?.consignPrice) !== null);

  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);
  return {
    productId1688,
    supplierId: optionalBoundedText(
      product.supplierUserId ?? product.sellerId ?? product.supplierLoginId,
      MAX_SUPPLIER_ID_LENGTH,
      'supplier ID',
    ),
    title,
    price: priceMin,
    priceMin,
    priceMax,
    mainImage,
    detailImages,
    categoryPath: categoryName,
    categoryL1: categoryName,
    skuList,
    attributes,
    monthlySold: parseCount(product.bookedCount),
    isCrossBorder: product.crossBorderOffer === true,
    isOnePieceDrop: isConsignOffer || hasConsignPrice,
  };
}

function mapSku(value: unknown, index: number): CrawledSku {
  const sku = recordValue(value);
  if (!sku) {
    throw new CrawlerError(`Alibaba 1688 SKU ${index + 1} is invalid`, 'parse');
  }
  const skuId = boundedSkuId(sku.specId ?? sku.skuId, index);
  const price = firstPositiveNumber([
    sku.consignPrice,
    sku.jxhyPrice,
    sku.pftPrice,
    sku.price,
    sku.retailPrice,
  ]);
  if (price === null) {
    throw new CrawlerError(`Alibaba 1688 SKU ${index + 1} price is invalid`, 'parse');
  }
  const stock = nonNegativeInteger(
    sku.amountOnSale,
    POSTGRES_INTEGER_MAX,
    `SKU ${index + 1} stock`,
  );
  const attributes = mapSkuAttributes(sku.attributes);
  const specName = Object.entries(attributes)
    .map(([key, item]) => `${key}:${item}`)
    .join(';');
  const image = normalizeImages(
    arrayValue(sku.attributes).map((item) => recordValue(item)?.skuImageUrl),
  )[0];
  return {
    skuId,
    specName: specName || skuId,
    price,
    stock,
    attributes,
    ...(image ? { image } : {}),
  };
}

function mapAttributes(value: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  const items = boundedArray(value, MAX_PRODUCT_ATTRIBUTES, 'product attributes');
  for (const item of items) {
    const record = recordValue(item);
    const rawName = stringValue(record?.attributeName);
    const rawContent = stringValue(record?.value);
    if (!rawName || !rawContent) continue;
    const name = boundedText(rawName, MAX_PRODUCT_ATTRIBUTE_NAME_LENGTH, 'product attribute name');
    const content = boundedText(
      rawContent,
      MAX_PRODUCT_ATTRIBUTE_VALUE_LENGTH,
      'product attribute value',
    );
    if (name && content && attributes[name] === undefined) attributes[name] = content;
  }
  return attributes;
}

function mapSkuAttributes(value: unknown): Record<string, string> {
  const attributes: Record<string, string> = {};
  const items = boundedArray(value, MAX_SKU_ATTRIBUTES, 'SKU attributes');
  for (const item of items) {
    const record = recordValue(item);
    const rawName = stringValue(record?.attributeDisplayName ?? record?.attributeName);
    const rawContent = stringValue(record?.attributeValue ?? record?.customValueName);
    if (!rawName || !rawContent) continue;
    const name = boundedText(rawName, MAX_SKU_ATTRIBUTE_NAME_LENGTH, 'SKU attribute name');
    const content = boundedText(rawContent, MAX_SKU_ATTRIBUTE_VALUE_LENGTH, 'SKU attribute value');
    if (name && content && attributes[name] === undefined) attributes[name] = content;
  }
  return attributes;
}

function serializeParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = sortJsonValue(child);
  }
  return result;
}

function normalizeImages(value: unknown): string[] {
  return unique(
    flattenStrings(value)
      .map(normalizeImageUrl)
      .filter((url): url is string => !!url),
  );
}

function flattenStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      return flattenStrings(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return [text];
}

function normalizeImageUrl(value: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new CrawlerError('Alibaba 1688 image URL is invalid', 'parse');
  }
  const candidate = value.startsWith('//')
    ? `https:${value}`
    : /^https?:\/\//i.test(value)
      ? value
      : `${IMAGE_BASE_URL}${value.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const normalized = url.toString();
  if (normalized.length > MAX_MAIN_IMAGE_LENGTH) {
    throw new CrawlerError('Alibaba 1688 image URL is invalid', 'parse');
  }
  return ['http:', 'https:'].includes(url.protocol) ? normalized : null;
}

function extractHtmlImages(html: string): string[] {
  return unique(
    [...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .filter((value): value is string => !!value)
      .map(normalizeImageUrl)
      .filter((url): url is string => !!url),
  );
}

function parseCount(value: unknown): number | undefined {
  const text = stringValue(value).replaceAll(',', '');
  if (!text) return undefined;
  const match = text.match(/^(\d+(?:\.\d+)?)(万)?/);
  if (!match?.[1]) return undefined;
  const count = Number(match[1]) * (match[2] ? 10_000 : 1);
  const normalized = Math.trunc(count);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > POSTGRES_INTEGER_MAX) {
    throw new CrawlerError('Alibaba 1688 monthly sales count is invalid', 'parse');
  }
  return normalized;
}

function isApiFailure(value: Record<string, unknown>): boolean {
  return value.success === false || value.success === 'false';
}

function apiError(operation: string, value: Record<string, unknown>): CrawlerError {
  const code = safeErrorCode(value.errorCode ?? value.code);
  return new CrawlerError(
    `Alibaba 1688 ${operation} failed (code ${code})`,
    classifyErrorCode(code),
  );
}

function classifyErrorCode(code: string): CrawlerError['code'] {
  if (/(AUTH|TOKEN|ACCESS|401|403)/i.test(code)) return 'auth';
  if (/(LIMIT|FLOW|THROTTL|429)/i.test(code)) return 'rate_limited';
  if (/(NOT.?FOUND|NOT.?EXIST|404)/i.test(code)) return 'not_found';
  return 'unknown';
}

function httpError(operation: string, status: number): CrawlerError {
  const code =
    status === 401 || status === 403
      ? 'auth'
      : status === 404
        ? 'not_found'
        : status === 429
          ? 'rate_limited'
          : status === 408 || status === 425 || status >= 500
            ? 'network'
            : 'unknown';
  return new CrawlerError(`Alibaba 1688 ${operation} failed (HTTP ${status})`, code, status);
}

function validateBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new CrawlerError('Alibaba 1688 base URL is invalid', 'auth');
  }
}

function validateSearchFilters(values: OpenApi1688SearchFilter[]): OpenApi1688SearchFilter[] {
  const filters = [...new Set(values)];
  if (filters.some((filter) => !SEARCH_FILTERS.has(filter))) {
    throw new CrawlerError('Alibaba 1688 search filter is invalid', 'parse');
  }
  return filters;
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  const text = stringValue(value);
  if (!text || text.length > maxLength || text.includes('\u0000')) {
    throw new CrawlerError(`Alibaba 1688 ${label} is invalid`, 'parse');
  }
  return text;
}

function optionalBoundedText(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedText(value, maxLength, label);
}

function boundedSkuId(value: unknown, index: number): string {
  const skuId = stringValue(value);
  if (!skuId || skuId.length > MAX_SKU_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(skuId)) {
    throw new CrawlerError(`Alibaba 1688 SKU ${index + 1} ID is invalid`, 'parse');
  }
  return skuId;
}

function boundedToken(value: unknown, maxLength: number, label: string): string {
  const text = boundedText(value, maxLength, label);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new CrawlerError(`Alibaba 1688 ${label} is invalid`, 'parse');
  }
  return text;
}

function positiveId(value: unknown, label: string): string {
  const id = optionalPositiveId(value);
  if (!id) throw new CrawlerError(`Alibaba 1688 ${label} is invalid`, 'parse');
  return id;
}

function optionalPositiveId(value: unknown): string | null {
  const id = stringValue(value);
  return id.length <= MAX_PRODUCT_ID_LENGTH && /^[1-9]\d*$/.test(id) ? id : null;
}

function firstPositiveNumber(values: unknown[]): number | null {
  for (const value of values) {
    const number = positiveNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function minimumPositiveNumber(values: unknown[]): number | null {
  const numbers = values.map(positiveNumber).filter((value): value is number => value !== null);
  return numbers.length ? Math.min(...numbers) : null;
}

function positiveNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  const roundedToCents = Math.round(number * 100) / 100;
  return Number.isFinite(number) &&
    number > 0 &&
    number <= MAX_SOURCE_PRICE &&
    Math.abs(number - roundedToCents) <= Number.EPSILON * Math.max(1, number) * 4
    ? number
    : null;
}

function nonNegativeInteger(value: unknown, max: number, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new CrawlerError(`Alibaba 1688 ${label} is invalid`, 'parse');
  }
  const text = typeof value === 'string' ? value.trim() : String(value);
  if (!/^\d+$/.test(text)) {
    throw new CrawlerError(`Alibaba 1688 ${label} is invalid`, 'parse');
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number > max) {
    throw new CrawlerError(`Alibaba 1688 ${label} is invalid`, 'parse');
  }
  return number;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function boundedArray(value: unknown, maxLength: number, label: string): unknown[] {
  const items = arrayValue(value);
  if (items.length > maxLength) {
    throw new CrawlerError(`Alibaba 1688 ${label} exceed ${maxLength} items`, 'parse');
  }
  return items;
}

function safeErrorCode(value: unknown): string {
  const code = stringValue(value);
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
