import type { PlatformType, TokenSet } from '@supplier/shared-types';
import { createHmac } from 'node:crypto';
import { BasePlatformAdapter } from '../adapter';
import type {
  AdapterConfig,
  CategoryAttr,
  CategoryNode,
  OrderQuery,
  PlatformOrder,
  PublishProductDto,
  PublishResult,
  ShipDto,
  ShipPackagesDto,
  SyncInventoryDto,
  UpdateProductDto,
} from '../types';

type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface Alibaba1688TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: string | number;
  memberId?: string | number;
  resource_owner?: string;
  scope?: string;
  error?: string;
  errorCode?: string;
}

interface Alibaba1688ApiResponse {
  success?: boolean | string;
  errorCode?: string;
  code?: string;
}

export interface Alibaba1688FastAddress {
  provinceText: string;
  cityText: string;
  areaText: string;
  townText?: string;
  address: string;
  fullName: string;
  mobile?: string;
  phone?: string;
  postCode?: string;
}

export interface Alibaba1688Cargo {
  offerId: string | number | bigint;
  specId?: string;
  quantity: number;
}

export interface Alibaba1688CreateOrderInput {
  flow: 'general' | 'saleproxy';
  address: Alibaba1688FastAddress;
  cargo: Alibaba1688Cargo[];
  outOrderId: string;
  message?: string;
  fenxiaoChannel?: 'douyin';
}

export interface Alibaba1688CreateOrderResult {
  orderId: string;
}

export interface Alibaba1688BuyerOrder {
  orderId: string;
  status: string;
  totalAmount: number | null;
  items: Array<{
    offerId: string;
    specId: string | null;
    subItemId: string;
    quantity: number;
    status: string;
  }>;
}

export interface Alibaba1688LogisticsInfo {
  trackingNo: string;
  carrier: string | null;
  status: string | null;
  orderEntryIds: string[];
}

const AUTH_URL = 'https://auth.1688.com/oauth/authorize';
const API_BASE_URL = 'https://gw.open.1688.com/openapi';
const REQUEST_TIMEOUT_MS = 10_000;

/** 1688 采购方适配器：OAuth、OpenAPI 签名与安全请求基座。 */
export class Alibaba1688Adapter extends BasePlatformAdapter {
  readonly platform: PlatformType = 'alibaba_1688';

  constructor(
    config: AdapterConfig,
    private readonly fetcher: HttpFetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    super(config);
  }

  buildAuthUrl(state: string): string {
    this.assertConfig();
    const params = new URLSearchParams({
      client_id: this.config.appKey,
      redirect_uri: this.config.redirectUri,
      site: '1688',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeToken(code: string): Promise<TokenSet> {
    if (!code.trim()) throw new Error('Alibaba 1688 authorization code is required');
    return this.requestToken('exchange', 'http', {
      client_id: this.config.appKey,
      client_secret: this.config.appSecret,
      code,
      grant_type: 'authorization_code',
      need_refresh_token: 'true',
      redirect_uri: this.config.redirectUri,
    });
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    if (!refreshToken.trim()) throw new Error('Alibaba 1688 refresh token is required');
    return this.requestToken('refresh', 'param2', {
      client_id: this.config.appKey,
      client_secret: this.config.appSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  async publishProduct(_token: string, _dto: PublishProductDto): Promise<PublishResult> {
    throw new Error('1688 不作为销售方铺货平台，这里仅用于代发下单');
  }

  async updateProduct(_token: string, _dto: UpdateProductDto): Promise<void> {
    throw new Error('Not applicable for 1688 buyer role');
  }

  async syncInventory(_token: string, _dto: SyncInventoryDto): Promise<void> {
    throw new Error('Not applicable for 1688 buyer role');
  }

  async offlineProduct(_token: string, _productId: string): Promise<void> {
    throw new Error('Not applicable for 1688 buyer role');
  }

  async getCategoryTree(_token: string): Promise<CategoryNode[]> {
    throw new Error('Not implemented: alibaba1688.getCategoryTree');
  }

  async getCategoryAttributes(_token: string, _categoryId: string): Promise<CategoryAttr[]> {
    throw new Error('Not implemented: alibaba1688.getCategoryAttributes');
  }

  async listOrders(_token: string, _query: OrderQuery): Promise<PlatformOrder[]> {
    throw new Error('Not applicable for 1688 buyer role');
  }

  async shipOrder(_token: string, _dto: ShipDto): Promise<void> {
    throw new Error('Not applicable for 1688 buyer role');
  }

  async shipPackages(_token: string, _dto: ShipPackagesDto): Promise<void> {
    throw new Error('Not applicable for 1688 buyer role');
  }

  async createOrder(
    accessToken: string,
    input: Alibaba1688CreateOrderInput,
  ): Promise<Alibaba1688CreateOrderResult> {
    if (input.flow !== 'general' && input.flow !== 'saleproxy') {
      throw new Error('Alibaba 1688 order flow is invalid');
    }
    const address = validateAddress(input.address);
    const cargo = normalizeCargo(input.cargo);
    const outOrderId = boundedText(input.outOrderId, 128, 'external order ID');
    const message = optionalBoundedText(input.message, 500, 'buyer message');
    const payload = await this.requestApi<{
      success?: boolean | string;
      errorCode?: string;
      code?: string;
      result?: { orderId?: string | number };
    }>('com.alibaba.trade', 'alibaba.trade.fastCreateOrder', 'order creation', accessToken, {
      flow: input.flow,
      addressParam: address,
      cargoParamList: cargo,
      outOrderId,
      ...(message ? { message } : {}),
      ...(input.fenxiaoChannel ? { fenxiaoChannel: input.fenxiaoChannel } : {}),
    });
    const orderId = stringValue(payload.result?.orderId);
    if (!orderId) throw new Error('Alibaba 1688 order creation returned an invalid response');
    return { orderId };
  }

  async findBuyerOrderByOutOrderId(
    accessToken: string,
    outOrderId: string,
  ): Promise<Alibaba1688BuyerOrder | null> {
    const normalizedOutOrderId = boundedText(outOrderId, 128, 'external order ID');
    const payload = await this.requestApi<{
      errorCode?: string;
      code?: string;
      result?: unknown;
      totalRecord?: unknown;
    }>(
      'com.alibaba.trade',
      'alibaba.trade.getBuyerOrderList',
      'buyer order recovery query',
      accessToken,
      { outOrderId: normalizedOutOrderId, page: 1, pageSize: 2 },
    );
    if (!Array.isArray(payload.result)) {
      throw new Error('Alibaba 1688 buyer order recovery query returned an invalid response');
    }
    const totalRecord = Number(payload.totalRecord);
    if (!Number.isSafeInteger(totalRecord) || totalRecord < 0) {
      throw new Error('Alibaba 1688 buyer order recovery query returned an invalid response');
    }
    if (totalRecord === 0 && payload.result.length === 0) return null;
    if (totalRecord !== 1 || payload.result.length !== 1) {
      throw new Error('Alibaba 1688 buyer order recovery query returned an invalid response');
    }
    return mapBuyerOrder(payload.result[0]);
  }

  async getBuyerOrder(accessToken: string, orderId: string): Promise<Alibaba1688BuyerOrder> {
    const normalizedOrderId = positiveId(orderId, 'order ID');
    const payload = await this.requestApi<{
      success?: boolean | string;
      errorCode?: string;
      code?: string;
      result?: unknown;
    }>('com.alibaba.trade', 'alibaba.trade.get.buyerView', 'buyer order query', accessToken, {
      webSite: '1688',
      orderId: normalizedOrderId,
      includeFields: 'NativeLogistics',
    });
    return mapBuyerOrder(payload.result, normalizedOrderId);
  }

  async getLogisticsInfos(
    accessToken: string,
    orderId: string,
  ): Promise<Alibaba1688LogisticsInfo[]> {
    const normalizedOrderId = positiveId(orderId, 'order ID');
    const payload = await this.requestApi<{
      success?: boolean | string;
      errorCode?: string;
      code?: string;
      result?: unknown;
    }>(
      'com.alibaba.logistics',
      'alibaba.trade.getLogisticsInfos.buyerView',
      'logistics query',
      accessToken,
      {
        orderId: normalizedOrderId,
        webSite: '1688',
        fields: 'company.name,sender,receiver,sendgood',
      },
    );
    if (!Array.isArray(payload.result)) {
      throw new Error('Alibaba 1688 logistics query returned an invalid response');
    }
    const logistics = payload.result.map((value) => {
      const item = recordValue(value);
      const rawCompany = item?.company;
      const company = recordValue(rawCompany);
      const trackingNo = stringValue(item?.logisticsId ?? item?.logisticsBillNo).trim();
      const carrier = optionalLogisticsText(company?.name, 64);
      const status = optionalLogisticsText(item?.status, 32);
      if (
        !item ||
        (rawCompany !== undefined && rawCompany !== null && !company) ||
        !safeResponseText(trackingNo, 64)
      ) {
        throw new Error('Alibaba 1688 logistics query returned an invalid response');
      }
      return {
        trackingNo,
        carrier,
        status,
        orderEntryIds: splitIds(item.orderEntryIds),
      };
    });
    if (new Set(logistics.map((item) => item.trackingNo)).size !== logistics.length) {
      throw new Error('Alibaba 1688 logistics query returned an invalid response');
    }
    return logistics;
  }

  protected sign(params: Record<string, unknown>): string {
    this.assertConfig();
    const urlPath = stringValue(params.urlPath);
    if (!isSafeUrlPath(urlPath)) {
      throw new Error('Alibaba 1688 signature URL path is invalid');
    }
    const serialized = Object.keys(params)
      .filter(
        (key) =>
          key !== 'urlPath' &&
          key !== '_aop_signature' &&
          params[key] !== undefined &&
          params[key] !== null,
      )
      .sort()
      .map((key) => `${key}${serializeParam(params[key])}`)
      .join('');
    return createHmac('sha1', this.config.appSecret)
      .update(`${urlPath}${serialized}`)
      .digest('hex')
      .toUpperCase();
  }

  protected async requestApi<T extends Alibaba1688ApiResponse>(
    namespace: string,
    method: string,
    operation: string,
    accessToken: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    this.assertConfig();
    if (!isSafeApiName(namespace) || !isSafeApiName(method)) {
      throw new Error('Alibaba 1688 API name is invalid');
    }
    if (!accessToken.trim()) {
      throw new Error('Alibaba 1688 access token is required');
    }
    if (
      Object.keys(params).some(
        (key) => key === 'urlPath' || key === '_aop_signature' || !isSafeParamName(key),
      )
    ) {
      throw new Error('Alibaba 1688 API parameter name is invalid');
    }

    const urlPath = `param2/1/${namespace}/${method}/${this.config.appKey}`;
    const requestParams: Record<string, unknown> = {
      ...params,
      access_token: accessToken,
    };
    requestParams._aop_signature = this.sign({ urlPath, ...requestParams });

    const response = await this.postForm(`${API_BASE_URL}/${urlPath}`, operation, requestParams);
    const payload = await parseJson<T>(response, `Alibaba 1688 ${operation}`);
    if (
      payload.success === false ||
      payload.success === 'false' ||
      (payload.errorCode && payload.success !== true && payload.success !== 'true')
    ) {
      throw new Error(
        `Alibaba 1688 ${operation} failed (code ${safeErrorCode(payload.errorCode ?? payload.code)})`,
      );
    }
    return payload;
  }

  private async requestToken(
    operation: 'exchange' | 'refresh',
    protocol: 'http' | 'param2',
    params: Record<string, string>,
  ): Promise<TokenSet> {
    this.assertConfig();
    const path = `${protocol}/1/system.oauth2/getToken/${this.config.appKey}`;
    const response = await this.postForm(`${API_BASE_URL}/${path}`, `token ${operation}`, params);
    const payload = await parseJson<Alibaba1688TokenResponse>(
      response,
      `Alibaba 1688 token ${operation}`,
    );
    if (payload.error || payload.errorCode) {
      throw new Error(
        `Alibaba 1688 token ${operation} failed (code ${safeErrorCode(payload.errorCode ?? payload.error)})`,
      );
    }

    const expiresIn = positiveSeconds(payload.expires_in);
    const platformShopId = stringValue(payload.memberId);
    if (!payload.access_token || !expiresIn || !platformShopId) {
      throw new Error(`Alibaba 1688 token ${operation} returned an invalid response`);
    }

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(this.now() + expiresIn * 1000),
      scope: payload.scope ? payload.scope.split(/[\s,]+/).filter(Boolean) : undefined,
      platformShopId,
      shopName: payload.resource_owner,
    };
  }

  private async postForm(
    url: string,
    operation: string,
    params: Record<string, unknown>,
  ): Promise<Response> {
    const body = new URLSearchParams(
      Object.keys(params)
        .filter((key) => params[key] !== undefined && params[key] !== null)
        .sort()
        .map((key) => [key, serializeParam(params[key])]),
    );

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`Alibaba 1688 ${operation} request failed`);
    }
    if (!response.ok) {
      throw new Error(`Alibaba 1688 ${operation} failed (HTTP ${response.status})`);
    }
    return response;
  }

  private assertConfig(): void {
    if (
      !this.config.appKey.trim() ||
      !/^[A-Za-z0-9_-]+$/.test(this.config.appKey) ||
      !this.config.appSecret ||
      !this.config.redirectUri.trim()
    ) {
      throw new Error('Alibaba 1688 adapter configuration is invalid');
    }
  }
}

function serializeParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new Error('Alibaba 1688 file parameters require the upload signing flow');
  }
  return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
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

async function parseJson<T>(response: Response, operation: string): Promise<T> {
  try {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid payload');
    }
    return payload as T;
  } catch {
    throw new Error(`${operation} returned an invalid response`);
  }
}

function positiveSeconds(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 31_536_000 ? number : null;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function safeErrorCode(value: unknown): string {
  const code = stringValue(value);
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : 'unknown';
}

function isSafeApiName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function isSafeParamName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function isSafeUrlPath(value: string): boolean {
  return /^param2\/1\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+$/.test(value);
}

function validateAddress(address: Alibaba1688FastAddress): Alibaba1688FastAddress {
  const normalized = {
    provinceText: boundedText(address.provinceText, 64, 'address province'),
    cityText: boundedText(address.cityText, 64, 'address city'),
    areaText: boundedText(address.areaText, 64, 'address area'),
    address: boundedText(address.address, 200, 'address detail'),
    fullName: boundedText(address.fullName, 25, 'receiver name'),
    townText: optionalBoundedText(address.townText, 64, 'address town'),
    mobile: optionalBoundedText(address.mobile, 30, 'receiver mobile'),
    phone: optionalBoundedText(address.phone, 30, 'receiver phone'),
    postCode: optionalBoundedText(address.postCode, 16, 'postal code'),
  };
  if (normalized.fullName.length < 2) {
    throw new Error('Alibaba 1688 receiver name must contain 2 to 25 characters');
  }
  if (!normalized.mobile && !normalized.phone) {
    throw new Error('Alibaba 1688 receiver mobile or phone is required');
  }
  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined),
  ) as unknown as Alibaba1688FastAddress;
}

function normalizeCargo(cargo: Alibaba1688Cargo[]): Alibaba1688Cargo[] {
  if (!Array.isArray(cargo) || cargo.length === 0) {
    throw new Error('Alibaba 1688 order requires at least one cargo item');
  }
  const normalized = new Map<string, Alibaba1688Cargo>();
  for (const item of cargo) {
    const offerId = positiveId(item.offerId, 'offer ID');
    const specId = optionalBoundedText(item.specId, 128, 'spec ID');
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1_000_000_000) {
      throw new Error('Alibaba 1688 cargo quantity is invalid');
    }
    const key = `${offerId}:${specId ?? ''}`;
    const quantity = (normalized.get(key)?.quantity ?? 0) + item.quantity;
    if (quantity > 1_000_000_000) {
      throw new Error('Alibaba 1688 cargo quantity is invalid');
    }
    normalized.set(key, {
      offerId,
      ...(specId ? { specId } : {}),
      quantity,
    });
  }
  return [...normalized.values()];
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  const text = stringValue(value);
  if (!text || text.length > maxLength) {
    throw new Error(`Alibaba 1688 ${label} is invalid`);
  }
  return text;
}

function optionalBoundedText(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedText(value, maxLength, label);
}

function positiveId(value: unknown, label: string): string {
  const id = stringValue(value);
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`Alibaba 1688 ${label} is invalid`);
  return id;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapBuyerOrder(value: unknown, fallbackOrderId?: string): Alibaba1688BuyerOrder {
  const result = recordValue(value);
  const baseInfo = recordValue(result?.baseInfo);
  const status = stringValue(baseInfo?.status).trim();
  if (!result || !baseInfo || !status || !Array.isArray(result.productItems)) {
    throw new Error('Alibaba 1688 buyer order query returned an invalid response');
  }
  const orderId = positiveId(
    stringValue(baseInfo.idOfStr ?? baseInfo.id) || fallbackOrderId || '',
    'order ID',
  );
  if (result.productItems.length === 0) {
    throw new Error('Alibaba 1688 buyer order query returned an invalid response');
  }
  const items = result.productItems.map(mapBuyerOrderItem);
  if (new Set(items.map((item) => item.subItemId)).size !== items.length) {
    throw new Error('Alibaba 1688 buyer order query returned an invalid response');
  }
  return {
    orderId,
    status,
    totalAmount: optionalBuyerOrderAmount(baseInfo.totalAmount),
    items,
  };
}

function mapBuyerOrderItem(value: unknown): Alibaba1688BuyerOrder['items'][number] {
  const item = recordValue(value);
  const offerId = stringValue(item?.productID).trim();
  const subItemId = stringValue(item?.subItemIDString ?? item?.subItemID).trim();
  const quantity = responseNumber(item?.quantity);
  const status = stringValue(item?.status).trim();
  const rawSpecId = item?.specId;
  const specId = stringValue(rawSpecId).trim() || null;
  if (
    !item ||
    !/^[1-9]\d*$/.test(offerId) ||
    !/^[^\u0000-\u001f\u007f]{1,128}$/u.test(subItemId) ||
    quantity === null ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    !status ||
    (rawSpecId !== undefined &&
      rawSpecId !== null &&
      rawSpecId !== '' &&
      typeof rawSpecId !== 'string' &&
      typeof rawSpecId !== 'number')
  ) {
    throw new Error('Alibaba 1688 buyer order query returned an invalid response');
  }
  return {
    offerId,
    specId,
    subItemId,
    quantity,
    status,
  };
}

function optionalBuyerOrderAmount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = responseNumber(value);
  if (number === null || number < 0) {
    throw new Error('Alibaba 1688 buyer order query returned an invalid response');
  }
  return number;
}

function responseNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeResponseText(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}

function optionalLogisticsText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('Alibaba 1688 logistics query returned an invalid response');
  }
  const text = value.trim();
  if (!text) return null;
  if (!safeResponseText(text, maxLength)) {
    throw new Error('Alibaba 1688 logistics query returned an invalid response');
  }
  return text;
}

function splitIds(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const entries = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' && typeof entry !== 'number') {
      throw new Error('Alibaba 1688 logistics query returned an invalid response');
    }
    const text = String(entry).trim();
    if (!text) {
      if (Array.isArray(value)) {
        throw new Error('Alibaba 1688 logistics query returned an invalid response');
      }
      return [];
    }
    ids.push(
      ...text
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }
  if (ids.some((id) => !safeResponseText(id, 128)) || new Set(ids).size !== ids.length) {
    throw new Error('Alibaba 1688 logistics query returned an invalid response');
  }
  return ids;
}
