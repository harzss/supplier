import type { PlatformType, TokenSet } from '@supplier/shared-types';
import { createHmac } from 'node:crypto';
import { BasePlatformAdapter } from '../adapter';
import { PlatformMutationResultUnknownError } from '../types';
import type {
  AdapterConfig,
  CategoryAttr,
  CategoryNode,
  CategoryPropertyMap,
  CategoryQualification,
  CategoryRecommendationInput,
  CategoryRecommendationResult,
  OrderQuery,
  PlatformExecutionGuard,
  PlatformOrder,
  PlatformProductInventoryState,
  PlatformProductPriceState,
  PlatformProductState,
  PlatformProductTitleState,
  PlatformShipmentPackage,
  PublishProductDto,
  PublishResult,
  ReplaceShipPackagesDto,
  ShipDto,
  ShipPackageDto,
  ShipPackagesDto,
  SyncInventoryDto,
  UpdateProductDto,
  UpdateProductPriceDto,
  UpdateProductTitleDto,
} from '../types';

type HttpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface DouyinTokenResponse {
  code?: number;
  err_no?: number;
  message?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    shop_id?: string | number;
    shop_name?: string;
  };
}

interface DouyinApiResponse<T> {
  code?: number;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
  data?: T;
}

interface DouyinProductAddData {
  product_id?: string | number;
}

interface DouyinInventorySyncData {
  results?: unknown[];
}

interface DouyinOrderListData {
  shop_order_list?: unknown[];
}

interface DouyinOrderDetailData {
  shop_order_detail?: unknown;
}

interface DouyinDecryptData {
  decrypt_infos?: unknown[];
}

interface DouyinCategoryRecommendationData {
  categoryDetails?: unknown[];
  recommend_id?: string;
  async_task_id?: string;
  async_task_status?: number | string;
  timeout?: number | string;
  interval?: number | string;
}

interface DouyinCategoryAttributesData {
  data?: unknown[];
  product_format?: unknown[];
}

interface DouyinCategoryQualificationsData {
  config_list?: unknown[];
}

interface DouyinProductDetailData {
  product_id?: number | string;
  product_id_str?: string;
  outer_product_id?: string;
  status?: number | string;
  check_status?: number | string;
  name?: string;
  spec_prices?: unknown[];
}

const PRODUCT_DETAIL_NOT_FOUND_SUB_CODES = [
  'isv.parameter-invalid:4',
  'isv.parameter-invalid:2010058',
] as const;

const API_BASE_URL = 'https://openapi-fxg.jinritemai.com';
const AUTH_URL = 'https://fuwu.jinritemai.com/authorize';
const API_VERSION = '2';
const MAX_CATEGORY_NODES = 20_000;
const CATEGORY_FETCH_CONCURRENCY = 6;
const ACCEPTED_INVENTORY_IDEMPOTENCY_RESPONSE = Symbol('accepted inventory idempotency response');

/**
 * 抖音小店适配器
 * 抖店 OAuth、商品发布、订单查询与物流回传适配器。
 */
export class DouyinAdapter extends BasePlatformAdapter {
  readonly platform: PlatformType = 'douyin';

  constructor(
    config: AdapterConfig,
    private readonly fetcher: HttpFetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly wait: (milliseconds: number) => Promise<void> = delay,
  ) {
    super(config);
  }

  buildAuthUrl(state: string): string {
    if (!this.config.serviceId) {
      throw new Error('Douyin serviceId is required');
    }
    const params = new URLSearchParams({
      service_id: this.config.serviceId,
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeToken(code: string): Promise<TokenSet> {
    return this.requestToken('/token/create', 'token.create', 'exchange', {
      code,
      grant_type: 'authorization_code',
    });
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    return this.requestToken('/token/refresh', 'token.refresh', 'refresh', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  async publishProduct(token: string, dto: PublishProductDto): Promise<PublishResult> {
    const mobile = this.config.customerMobile?.trim();
    if (!mobile) {
      throw new Error('Douyin customer mobile is required');
    }

    const data = await this.requestApi<DouyinProductAddData>(
      '/product/addV2',
      'product.addV2',
      'product publish',
      token,
      buildProductPayload(dto, mobile),
    );
    const productId = stringValue(data?.product_id);
    if (!productId) {
      throw new Error('Douyin product publish returned an invalid response');
    }
    return { platformProductId: productId };
  }

  async findProductByExternalId(
    token: string,
    externalProductId: string,
  ): Promise<PublishResult | null> {
    const externalId = boundedText(externalProductId, 255, 'external product ID');
    const data = await this.requestApi<DouyinProductDetailData>(
      '/product/detail',
      'product.detail',
      'product detail',
      token,
      { out_product_id: externalId, show_draft: 'true' },
      PRODUCT_DETAIL_NOT_FOUND_SUB_CODES,
    );
    if (!data) return null;
    const productId = stringValue(data.product_id_str ?? data.product_id);
    if (!/^\d+$/.test(productId)) {
      throw new Error('Douyin product detail returned an invalid response');
    }
    const returnedExternalId = stringValue(data.outer_product_id);
    if (returnedExternalId && returnedExternalId !== externalId) {
      throw new Error('Douyin product detail returned a mismatched external product ID');
    }
    return { platformProductId: productId };
  }

  async updateProduct(token: string, dto: UpdateProductDto): Promise<void> {
    const mobile = this.config.customerMobile?.trim();
    if (!mobile) {
      throw new Error('Douyin customer mobile is required');
    }
    const productId = positiveNumericId(dto.platformProductId, 'product ID');
    await this.requestApi<undefined>('/product/editV2', 'product.editV2', 'product update', token, {
      ...buildProductPayload(dto, mobile),
      force_use_quality_list: true,
      product_id: productId,
      quality_list: serializeQualifications(dto.qualifications ?? []),
    });
  }

  async updateProductTitle(token: string, dto: UpdateProductTitleDto): Promise<void> {
    const productId = positiveNumericId(dto.platformProductId, 'product ID');
    const title = validDouyinTitle(dto.title);
    try {
      await this.requestApi<undefined>(
        '/product/partialEdit',
        'product.partialEdit',
        'product title update',
        token,
        { name: title, product_id: productId },
      );
    } catch (error) {
      if (mutationResultIsUnknown(error, 'product title update')) {
        throw new PlatformMutationResultUnknownError(
          error instanceof Error ? error.message : 'Douyin product title update result is unknown',
        );
      }
      throw error;
    }
  }

  async getProductTitle(token: string, productIdValue: string): Promise<PlatformProductTitleState> {
    const productId = positiveNumericId(productIdValue, 'product ID');
    const data = await this.requestApi<DouyinProductDetailData>(
      '/product/detail',
      'product.detail',
      'product detail',
      token,
      { product_id: productId, show_draft: 'true' },
    );
    if (!data) throw new Error('Douyin product detail returned an invalid response');
    assertProductDetailId(data, productId);
    const title = stringValue(data.name).trim();
    if (!title || title.length > 60) {
      throw new Error('Douyin product detail returned an invalid product title');
    }
    const status = optionalInteger(data.status);
    const checkStatus = optionalInteger(data.check_status);
    return {
      state: mapProductState(status, checkStatus),
      status,
      checkStatus,
      title,
    };
  }

  async updateProductPrice(token: string, dto: UpdateProductPriceDto): Promise<void> {
    const productId = positiveNumericId(dto.platformProductId, 'product ID');
    const sourceSkuId = strictExternalSkuId(dto.sourceSkuId);
    const priceCents = positiveInteger(dto.priceCents, 'SKU price in cents');
    await this.requestApi<undefined>(
      '/sku/editPrice',
      'sku.editPrice',
      'product price update',
      token,
      {
        price: priceCents,
        out_sku_id: sourceSkuId,
        product_id: productId,
      },
    );
  }

  async getProductPrices(
    token: string,
    productIdValue: string,
  ): Promise<PlatformProductPriceState> {
    const productId = positiveNumericId(productIdValue, 'product ID');
    const data = await this.requestApi<DouyinProductDetailData>(
      '/product/detail',
      'product.detail',
      'product detail',
      token,
      { product_id: productId },
    );
    if (!data) throw new Error('Douyin product detail returned an invalid response');
    assertProductDetailId(data, productId);
    const status = optionalInteger(data.status);
    const checkStatus = optionalInteger(data.check_status);
    return {
      state: mapProductState(status, checkStatus),
      status,
      checkStatus,
      items: parseProductPrices(data.spec_prices),
    };
  }

  async getProductInventory(
    token: string,
    productIdValue: string,
  ): Promise<PlatformProductInventoryState> {
    const productId = positiveNumericId(productIdValue, 'product ID');
    const data = await this.requestApi<DouyinProductDetailData>(
      '/product/detail',
      'product.detail',
      'product detail',
      token,
      { product_id: productId },
    );
    if (!data) throw new Error('Douyin product detail returned an invalid response');
    assertProductDetailId(data, productId);
    const status = optionalInteger(data.status);
    const checkStatus = optionalInteger(data.check_status);
    return {
      state: mapProductState(status, checkStatus),
      status,
      checkStatus,
      items: parseProductInventory(data.spec_prices),
    };
  }

  async getProductState(token: string, productIdValue: string): Promise<PlatformProductState> {
    const productId = positiveNumericId(productIdValue, 'product ID');
    const data = await this.requestApi<DouyinProductDetailData>(
      '/product/detail',
      'product.detail',
      'product detail',
      token,
      { product_id: productId },
    );
    if (!data) throw new Error('Douyin product detail returned an invalid response');
    assertProductDetailId(data, productId);
    const status = optionalInteger(data.status);
    const checkStatus = optionalInteger(data.check_status);
    return { state: mapProductState(status, checkStatus), status, checkStatus };
  }

  async syncInventory(token: string, dto: SyncInventoryDto): Promise<void> {
    const productId = positiveNumericId(dto.platformProductId, 'product ID');
    const idempotencyKey = boundedText(dto.idempotencyKey, 120, 'inventory idempotency key');
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new Error('Douyin inventory sync requires at least one SKU');
    }
    const sourceSkuIds = new Set<string>();
    const items = dto.items.map((item, index) => {
      const sourceSkuId = boundedText(item.sourceSkuId, 128, 'external SKU ID');
      if (sourceSkuIds.has(sourceSkuId)) {
        throw new Error(`Douyin inventory sync contains duplicate external SKU ID: ${sourceSkuId}`);
      }
      sourceSkuIds.add(sourceSkuId);
      return {
        out_sku_id: sourceSkuId,
        product_id: productId,
        stock_num: toStock(item.stock),
        uniq_id: String(index + 1),
      };
    });

    const chunks = chunk(items, 50);
    for (const [index, current] of chunks.entries()) {
      const chunkKey = chunks.length === 1 ? idempotencyKey : `${idempotencyKey}-${index + 1}`;
      let data:
        | DouyinInventorySyncData
        | typeof ACCEPTED_INVENTORY_IDEMPOTENCY_RESPONSE
        | undefined;
      try {
        data = await this.requestApi<
          DouyinInventorySyncData | typeof ACCEPTED_INVENTORY_IDEMPOTENCY_RESPONSE
        >(
          '/sku/syncStockBatchMultiProducts',
          'sku.syncStockBatchMultiProducts',
          'inventory sync',
          token,
          {
            idempotent_id: chunkKey,
            incremental: false,
            inventory_loss: false,
            items: current,
            source: 'supplier',
          },
          ['isv.business-failed:-20002'],
          ACCEPTED_INVENTORY_IDEMPOTENCY_RESPONSE,
        );
      } catch (error) {
        if (mutationResultIsUnknown(error, 'inventory sync')) {
          throw new PlatformMutationResultUnknownError(
            error instanceof Error ? error.message : 'Douyin inventory sync result is unknown',
          );
        }
        throw error;
      }
      if (data === ACCEPTED_INVENTORY_IDEMPOTENCY_RESPONSE) continue;
      try {
        validateInventoryResults(
          data?.results,
          current.map((item) => item.uniq_id),
        );
      } catch (error) {
        if (error instanceof InvalidInventoryMutationResponseError) {
          throw new PlatformMutationResultUnknownError(error.message);
        }
        throw error;
      }
    }
  }

  async offlineProduct(token: string, productIdValue: string): Promise<void> {
    const productId = positiveNumericId(productIdValue, 'product ID');
    try {
      await this.requestApi<undefined>(
        '/product/setOffline',
        'product.setOffline',
        'product offline',
        token,
        { product_id: productId },
        [
          'isv.parameter-invalid:2010021',
          'isv.business-failed:2010058',
          'isv.business-failed:2010064',
        ],
      );
    } catch (error) {
      if (mutationResultIsUnknown(error, 'product offline')) {
        throw new PlatformMutationResultUnknownError(
          error instanceof Error ? error.message : 'Douyin product offline result is unknown',
        );
      }
      throw error;
    }
  }

  async onlineProduct(token: string, productIdValue: string): Promise<void> {
    const productId = positiveNumericId(productIdValue, 'product ID');
    try {
      await this.requestApi<undefined>(
        '/product/setOnline',
        'product.setOnline',
        'product online',
        token,
        { product_id: productId },
      );
    } catch (error) {
      if (mutationResultIsUnknown(error, 'product online')) {
        throw new PlatformMutationResultUnknownError(
          error instanceof Error ? error.message : 'Douyin product online result is unknown',
        );
      }
      throw error;
    }
  }

  async getCategoryTree(token: string): Promise<CategoryNode[]> {
    const pending = ['0'];
    const requested = new Set<string>();
    const nodes = new Map<string, CategoryNode>();

    while (pending.length > 0) {
      const parents = pending.splice(0, CATEGORY_FETCH_CONCURRENCY).filter((id) => {
        if (requested.has(id)) return false;
        requested.add(id);
        return true;
      });
      if (parents.length === 0) continue;

      const batches = await Promise.all(
        parents.map(async (parentId) => ({
          parentId,
          children: await this.requestApi<unknown[]>(
            '/shop/getShopCategory',
            'shop.getShopCategory',
            'category tree',
            token,
            { channel: 0, cid: Number(parentId) },
          ),
        })),
      );

      for (const batch of batches) {
        if (!Array.isArray(batch.children)) {
          throw new Error('Douyin category tree returned an invalid response');
        }
        for (const value of batch.children) {
          const category = mapCategoryNode(value, batch.parentId);
          const existing = nodes.get(category.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(category)) {
            throw new Error('Douyin category tree returned conflicting nodes');
          }
          nodes.set(category.id, category);
          if (nodes.size > MAX_CATEGORY_NODES) {
            throw new Error('Douyin category tree exceeded the safety limit');
          }
          if (category.enabled !== false && !category.isLeaf) pending.push(category.id);
        }
      }
    }

    if (nodes.size === 0) throw new Error('Douyin category tree returned no categories');
    return [...nodes.values()].sort(
      (left, right) => left.level - right.level || left.id.localeCompare(right.id),
    );
  }

  async getCategoryAttributes(token: string, categoryIdValue: string): Promise<CategoryAttr[]> {
    const categoryId = Number(positiveSafeIntegerId(categoryIdValue, 'category ID'));
    const data = await this.requestApi<DouyinCategoryAttributesData | unknown[]>(
      '/product/getCatePropertyV2',
      'product.getCatePropertyV2',
      'category attributes',
      token,
      { category_leaf_id: categoryId, need_process_prop_cascade: true },
    );
    const record = recordValue(data);
    const values = Array.isArray(data) ? data : arrayValue(record?.data ?? record?.product_format);
    if (values.length === 0) return [];
    return values
      .flatMap(mapCategoryAttribute)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async getCategoryQualifications(
    token: string,
    categoryIdValue: string,
  ): Promise<CategoryQualification[]> {
    const categoryId = Number(positiveSafeIntegerId(categoryIdValue, 'category ID'));
    const data = await this.requestApi<DouyinCategoryQualificationsData>(
      '/product/qualificationConfig',
      'product.qualificationConfig',
      'category qualifications',
      token,
      { category_id: categoryId },
    );
    const values = arrayValue(data?.config_list);
    return values
      .map(mapCategoryQualification)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async recommendCategories(
    token: string,
    input: CategoryRecommendationInput,
  ): Promise<CategoryRecommendationResult> {
    const title = boundedText(input.title, 255, 'category recommendation title');
    let asyncTaskId: string | undefined;
    let elapsed = 0;
    let maxWait = 10_000;

    for (let attempt = 0; attempt < 20; attempt++) {
      const data = await this.requestApi<DouyinCategoryRecommendationData>(
        '/product/GetRecommendCategory',
        'product.GetRecommendCategory',
        'category recommendation',
        token,
        {
          scene: 'category_infer',
          name: title,
          ...(asyncTaskId ? { async_task_id: asyncTaskId } : {}),
        },
      );
      if (!data) throw new Error('Douyin category recommendation returned an invalid response');

      const status = optionalInteger(data.async_task_status);
      const nextTaskId = stringValue(data.async_task_id).trim();
      if (!nextTaskId || status === null || status === 2) {
        return {
          recommendations: mapCategoryRecommendations(data.categoryDetails),
          ...(stringValue(data.recommend_id).trim()
            ? { recommendId: stringValue(data.recommend_id).trim() }
            : {}),
        };
      }
      if (status === 3) throw new Error('Douyin category recommendation failed');
      if (status !== 0 && status !== 1) {
        throw new Error('Douyin category recommendation returned an invalid response');
      }

      asyncTaskId = nextTaskId;
      maxWait = clampInteger(data.timeout, 1_000, 20_000, maxWait);
      const interval = clampInteger(data.interval, 200, 2_000, 1_000);
      if (elapsed + interval > maxWait) {
        throw new Error('Douyin category recommendation timed out');
      }
      await this.wait(interval);
      elapsed += interval;
    }

    throw new Error('Douyin category recommendation timed out');
  }

  async listOrders(token: string, query: OrderQuery): Promise<PlatformOrder[]> {
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 100)));
    const page = parsePage(query.cursor);
    const params: Record<string, unknown> = {
      order_asc: false,
      order_by: 'update_time',
      page,
      size: pageSize,
    };
    if (query.startTime) params.update_time_start = Math.floor(query.startTime.getTime() / 1000);
    if (query.endTime) params.update_time_end = Math.floor(query.endTime.getTime() / 1000);
    if (query.status) params.combine_status = [{ order_status: query.status }];

    const data = await this.requestApi<DouyinOrderListData>(
      '/order/searchList',
      'order.searchList',
      'order list',
      token,
      params,
    );
    if (!Array.isArray(data?.shop_order_list)) {
      throw new Error('Douyin order list returned an invalid response');
    }
    const decrypted = await this.decryptPaidOrderFields(token, data.shop_order_list);
    return data.shop_order_list.map((order) => mapOrder(order, decrypted));
  }

  async getOrder(token: string, platformOrderIdValue: string): Promise<PlatformOrder> {
    const platformOrderId = boundedText(platformOrderIdValue, 64, 'parent order ID');
    const data = await this.requestApi<DouyinOrderDetailData>(
      '/order/orderDetail',
      'order.orderDetail',
      'order detail',
      token,
      { shop_order_id: platformOrderId },
    );
    if (!data?.shop_order_detail) {
      throw new Error('Douyin order detail returned an invalid response');
    }
    const decrypted = await this.decryptPaidOrderFields(token, [data.shop_order_detail]);
    const order = mapOrder(data.shop_order_detail, decrypted);
    if (order.platformOrderId !== platformOrderId) {
      throw new Error('Douyin order detail returned a different order');
    }
    return order;
  }

  async shipOrder(token: string, dto: ShipDto): Promise<void> {
    const companyCodes = await this.resolveCarrierCodes(token, [dto.carrier]);
    const companyCode = companyCodes.get(dto.carrier)!;
    await this.requestApi<undefined>(
      '/order/logisticsAdd',
      'order.logisticsAdd',
      'order shipment',
      token,
      {
        company: dto.carrier,
        company_code: companyCode,
        logistics_code: dto.trackingNo,
        order_id: dto.platformOrderId,
      },
    );
  }

  async shipPackages(token: string, dto: ShipPackagesDto): Promise<void> {
    const orderId = boundedText(dto.platformOrderId, 64, 'parent order ID');
    const requestId = boundedText(dto.requestId, 128, 'shipment request ID');
    if (!Array.isArray(dto.packages) || dto.packages.length === 0) {
      throw new Error('Douyin multi-package shipment requires at least one package');
    }
    const companyCodes = await this.resolveCarrierCodes(
      token,
      dto.packages.map((pack) => pack.carrier),
    );
    const packList = dto.packages.map((pack) => {
      const logisticsCode = boundedText(pack.trackingNo, 64, 'logistics code');
      const company = boundedText(pack.carrier, 64, 'logistics company');
      if (!Array.isArray(pack.items) || pack.items.length === 0) {
        throw new Error('Douyin shipment package requires at least one order item');
      }
      return {
        company,
        company_code: companyCodes.get(pack.carrier)!,
        logistics_code: logisticsCode,
        shipped_order_info: pack.items.map((item) => ({
          shipped_num: positiveInteger(item.quantity, 'shipped quantity'),
          shipped_order_id: boundedText(item.platformOrderItemId, 64, 'shipped order ID'),
        })),
      };
    });
    await this.requestApi<undefined>(
      '/order/logisticsAddMultiPack',
      'order.logisticsAddMultiPack',
      'multi-package shipment',
      token,
      {
        order_id: orderId,
        pack_list: packList,
        request_id: requestId,
      },
    );
  }

  async replaceShipPackages(
    token: string,
    dto: ReplaceShipPackagesDto,
    guard?: PlatformExecutionGuard,
  ): Promise<void> {
    const orderId = strictShipmentText(dto.platformOrderId, 64, 'parent order ID');
    const previousPackages = validatePreviousShipmentPackages(dto.previousPackages);
    const targetPackages = validateTargetShipmentPackages(dto.targetPackages);
    const previousByItems = shipmentPackagesByItems(previousPackages);
    const targetByItems = shipmentPackagesByItems(targetPackages);
    if (!sameKeys(previousByItems, targetByItems)) {
      throw new Error('Douyin shipment replacement cannot change package item groups');
    }

    await guard?.assertOwned();
    const companyCodes = await this.resolveCarrierCodes(
      token,
      [...previousPackages, ...targetPackages].map((pack) => pack.carrier),
    );
    await guard?.assertOwned();
    const resolvedPrevious = previousPackages.map((pack) => ({
      ...pack,
      companyCode: companyCodes.get(pack.carrier)!,
    }));
    const resolvedTargets = targetPackages.map((pack) => ({
      ...pack,
      companyCode: companyCodes.get(pack.carrier)!,
    }));
    const previousByItemsWithCodes = shipmentPackagesByItems(resolvedPrevious);
    const targetByItemsWithCodes = shipmentPackagesByItems(resolvedTargets);
    await guard?.assertOwned();
    const currentOrder = await this.getOrder(token, orderId);
    await guard?.assertOwned();
    const currentByItems = shipmentPackagesByItems(currentOrder.shipmentPackages);
    if (
      currentOrder.platformOrderId !== orderId ||
      !sameKeys(currentByItems, targetByItemsWithCodes)
    ) {
      throw new Error('Douyin shipment replacement found an unexpected platform snapshot');
    }

    const pending: Array<{
      current: PlatformShipmentPackage;
      target: (typeof resolvedTargets)[number];
    }> = [];
    for (const [itemsKey, target] of targetByItemsWithCodes) {
      const current = currentByItems.get(itemsKey)!;
      const previous = previousByItemsWithCodes.get(itemsKey)!;
      if (sameShipmentRoute(current, target)) continue;
      if (!sameShipmentRoute(current, previous)) {
        throw new Error('Douyin shipment replacement found an unexpected platform snapshot');
      }
      pending.push({ current, target });
    }

    if (pending.length === 0) {
      if (currentOrder.status !== 'shipped' && currentOrder.status !== 'received') {
        throw new Error('Douyin shipment replacement requires a shipped or received order');
      }
      return;
    }
    if (currentOrder.status !== 'shipped') {
      throw new Error('Douyin shipment replacement requires a shipped order');
    }

    for (const { current, target } of pending) {
      await guard?.assertOwned();
      await this.requestApi<undefined>(
        '/order/logisticsEditByPack',
        'order.logisticsEditByPack',
        'multi-package shipment replacement',
        token,
        {
          company_code: target.companyCode,
          logistics_code: target.trackingNo,
          order_id: orderId,
          pack_id: current.deliveryId,
        },
      );
      await guard?.assertOwned();
    }

    await guard?.assertOwned();
    const verifiedOrder = await this.getOrder(token, orderId);
    await guard?.assertOwned();
    if (
      verifiedOrder.platformOrderId !== orderId ||
      (verifiedOrder.status !== 'shipped' && verifiedOrder.status !== 'received') ||
      !shipmentSnapshotMatchesTarget(verifiedOrder.shipmentPackages, resolvedTargets)
    ) {
      throw new Error('Douyin shipment replacement verification failed');
    }
  }

  protected sign(params: Record<string, unknown>): string {
    const serialized = [
      'app_key',
      this.config.appKey,
      'method',
      String(params.method ?? ''),
      'param_json',
      String(params.param_json ?? ''),
      'timestamp',
      String(params.timestamp ?? ''),
      'v',
      String(params.v ?? ''),
    ].join('');
    const signPattern = `${this.config.appSecret}${serialized}${this.config.appSecret}`;
    return createHmac('sha256', this.config.appSecret).update(signPattern).digest('hex');
  }

  private async requestToken(
    path: '/token/create' | '/token/refresh',
    method: 'token.create' | 'token.refresh',
    operation: 'exchange' | 'refresh',
    params: Record<string, string>,
  ): Promise<TokenSet> {
    const timestamp = Math.floor(this.now() / 1000).toString();
    const paramJson = canonicalJson(params);
    const sign = this.sign({ method, param_json: paramJson, timestamp, v: API_VERSION });
    const query = new URLSearchParams({
      app_key: this.config.appKey,
      method,
      timestamp,
      v: API_VERSION,
      sign,
      sign_method: 'hmac-sha256',
    });

    let response: Response;
    try {
      response = await this.fetcher(`${API_BASE_URL}${path}?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: paramJson,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Douyin token ${operation} request failed`);
    }

    if (!response.ok) {
      throw new Error(`Douyin token ${operation} failed (HTTP ${response.status})`);
    }

    const payload = await this.parseTokenResponse(response, operation);
    const errorCode = payload.err_no ?? payload.code;
    if (typeof errorCode === 'number' && errorCode !== 0) {
      throw new Error(
        `Douyin token ${operation} failed: ${safeMessage(payload.message, errorCode)}`,
      );
    }

    const data = payload.data;
    if (
      !data?.access_token ||
      typeof data.expires_in !== 'number' ||
      data.expires_in <= 0 ||
      data.shop_id === undefined
    ) {
      throw new Error(`Douyin token ${operation} returned an invalid response`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(this.now() + data.expires_in * 1000),
      scope: data.scope ? data.scope.split(/[\s,]+/).filter(Boolean) : undefined,
      platformShopId: String(data.shop_id),
      shopName: data.shop_name,
    };
  }

  private async parseTokenResponse(
    response: Response,
    operation: 'exchange' | 'refresh',
  ): Promise<DouyinTokenResponse> {
    try {
      return (await response.json()) as DouyinTokenResponse;
    } catch {
      throw new Error(`Douyin token ${operation} returned an invalid response`);
    }
  }

  private async requestApi<T>(
    path:
      | '/product/addV2'
      | '/product/editV2'
      | '/product/partialEdit'
      | '/product/detail'
      | '/product/GetRecommendCategory'
      | '/product/getCatePropertyV2'
      | '/product/qualificationConfig'
      | '/product/setOnline'
      | '/product/setOffline'
      | '/shop/getShopCategory'
      | '/sku/editPrice'
      | '/sku/syncStockBatchMultiProducts'
      | '/order/orderDetail'
      | '/order/searchList'
      | '/order/batchDecrypt'
      | '/order/logisticsCompanyList'
      | '/order/logisticsAdd'
      | '/order/logisticsAddMultiPack'
      | '/order/logisticsEditByPack',
    method:
      | 'product.addV2'
      | 'product.editV2'
      | 'product.partialEdit'
      | 'product.detail'
      | 'product.GetRecommendCategory'
      | 'product.getCatePropertyV2'
      | 'product.qualificationConfig'
      | 'product.setOnline'
      | 'product.setOffline'
      | 'shop.getShopCategory'
      | 'sku.editPrice'
      | 'sku.syncStockBatchMultiProducts'
      | 'order.orderDetail'
      | 'order.searchList'
      | 'order.batchDecrypt'
      | 'order.logisticsCompanyList'
      | 'order.logisticsAdd'
      | 'order.logisticsAddMultiPack'
      | 'order.logisticsEditByPack',
    operation:
      | 'product publish'
      | 'product update'
      | 'product title update'
      | 'product detail'
      | 'category recommendation'
      | 'category attributes'
      | 'category qualifications'
      | 'category tree'
      | 'product online'
      | 'product offline'
      | 'product price update'
      | 'inventory sync'
      | 'order detail'
      | 'order list'
      | 'order decryption'
      | 'logistics company list'
      | 'order shipment'
      | 'multi-package shipment'
      | 'multi-package shipment replacement',
    accessToken: string,
    params: Record<string, unknown>,
    acceptedSubCodes: readonly string[] = [],
    acceptedResult?: T,
  ): Promise<T | undefined> {
    const timestamp = formatDouyinTimestamp(this.now());
    const paramJson = canonicalJson(params);
    const sign = this.sign({ method, param_json: paramJson, timestamp, v: API_VERSION });
    const query = new URLSearchParams({
      access_token: accessToken,
      app_key: this.config.appKey,
      method,
      sign,
      sign_method: 'hmac-sha256',
      timestamp,
      v: API_VERSION,
    });

    let response: Response;
    try {
      response = await this.fetcher(`${API_BASE_URL}${path}?${query.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: paramJson,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Douyin ${operation} request failed`);
    }

    if (!response.ok) {
      throw new Error(`Douyin ${operation} failed (HTTP ${response.status})`);
    }

    let payload: DouyinApiResponse<T>;
    try {
      payload = (await response.json()) as DouyinApiResponse<T>;
    } catch {
      throw new Error(`Douyin ${operation} returned an invalid response`);
    }
    if (!payload || typeof payload !== 'object' || !Number.isSafeInteger(payload.code)) {
      throw new Error(`Douyin ${operation} returned an invalid response`);
    }
    if (payload.code !== 10000) {
      if (!acceptedSubCodes.includes(payload.sub_code ?? '')) {
        throw new Error(
          `Douyin ${operation} failed: ${safeMessage(payload.sub_msg ?? payload.msg, payload.code ?? -1)}`,
        );
      }
      return acceptedResult;
    }
    return payload.data as T;
  }

  private async resolveCarrierCodes(
    token: string,
    carriers: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const unresolved = uniqueStrings(carriers).filter((carrier) => {
      const code = directCarrierCode(carrier);
      if (code) result.set(carrier, code);
      return !code;
    });
    if (unresolved.length === 0) return result;

    const data = await this.requestApi<unknown[]>(
      '/order/logisticsCompanyList',
      'order.logisticsCompanyList',
      'logistics company list',
      token,
      {},
    );
    if (!Array.isArray(data)) {
      throw new Error('Douyin logistics company list returned an invalid response');
    }
    const companies = data.flatMap((value) => {
      const company = recordValue(value);
      const name = stringValue(company?.name);
      const code = stringValue(company?.code);
      return name && /^[a-z0-9_-]+$/i.test(code) ? [{ name, code }] : [];
    });
    for (const carrier of unresolved) {
      const normalized = normalizeCarrierName(carrier);
      const matches = companies.filter(
        (company) => normalizeCarrierName(company.name) === normalized,
      );
      if (matches.length !== 1) {
        throw new Error(`Douyin logistics company code is unknown: ${carrier.slice(0, 50)}`);
      }
      result.set(carrier, matches[0]!.code);
    }
    return result;
  }

  private async decryptPaidOrderFields(
    token: string,
    orders: unknown[],
  ): Promise<Map<string, string>> {
    const uniqueCipherInfos = new Map<string, { auth_id: string; cipher_text: string }>();
    for (const value of orders) {
      const order = recordValue(value);
      const orderId = stringValue(order?.order_id);
      if (!order || !orderId || mapOrderStatus(stringValue(order.order_status)) !== 'paid') {
        continue;
      }
      const address = recordValue(order.post_addr);
      for (const cipherText of [
        order.encrypt_post_receiver,
        order.encrypt_post_tel,
        address?.encrypt_detail,
      ].map(stringValue)) {
        if (!cipherText) continue;
        uniqueCipherInfos.set(decryptionKey(orderId, cipherText), {
          auth_id: orderId,
          cipher_text: cipherText,
        });
      }
    }
    const cipherInfos = [...uniqueCipherInfos.values()];
    if (cipherInfos.length === 0) return new Map();

    const result = new Map<string, string>();
    const pending = [...cipherInfos];
    while (pending.length) {
      const batch: typeof cipherInfos = [];
      const batchCipherTexts = new Set<string>();
      for (let index = 0; index < pending.length && batch.length < 50; ) {
        const item = pending[index]!;
        if (batchCipherTexts.has(item.cipher_text)) {
          index++;
          continue;
        }
        batchCipherTexts.add(item.cipher_text);
        batch.push(item);
        pending.splice(index, 1);
      }
      const data = await this.requestApi<DouyinDecryptData>(
        '/order/batchDecrypt',
        'order.batchDecrypt',
        'order decryption',
        token,
        { cipher_infos: batch },
      );
      if (!Array.isArray(data?.decrypt_infos)) {
        throw new Error('Douyin order decryption returned an invalid response');
      }
      for (const value of data.decrypt_infos) {
        const item = recordValue(value);
        const authId = stringValue(item?.auth_id);
        const cipherText = stringValue(item?.cipher_text);
        const decryptText = stringValue(item?.decrypt_text);
        if (!item || !cipherText || !decryptText || (item.err_no !== 0 && item.err_no !== '0')) {
          throw new Error('Douyin order decryption returned an invalid response');
        }
        const matches = authId
          ? batch.filter(
              (requested) => requested.auth_id === authId && requested.cipher_text === cipherText,
            )
          : batch.filter((requested) => requested.cipher_text === cipherText);
        if (matches.length !== 1) {
          throw new Error('Douyin order decryption returned an invalid response');
        }
        const key = decryptionKey(matches[0]!.auth_id, cipherText);
        const existing = result.get(key);
        if (existing && existing !== decryptText) {
          throw new Error('Douyin order decryption returned an invalid response');
        }
        result.set(key, decryptText);
      }
      if (batch.some((item) => !result.has(decryptionKey(item.auth_id, item.cipher_text)))) {
        throw new Error('Douyin order decryption did not return every requested field');
      }
    }
    return result;
  }
}

function buildProductPayload(dto: PublishProductDto, mobile: string): Record<string, unknown> {
  const categoryId = Number(dto.categoryId);
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
    throw new Error('Douyin categoryId must be a positive integer');
  }

  const mainImages = uniqueHttpUrls(dto.mainImages).slice(0, 5);
  if (mainImages.length === 0) {
    throw new Error('Douyin product requires at least one image');
  }

  const detailImages = uniqueHttpUrls([...extractHttpUrls(dto.detailHtml), ...mainImages]).slice(
    0,
    50 - mainImages.length,
  );
  const skus = dto.skus.length
    ? dto.skus
    : [{ specName: '默认', price: dto.salePrice, stock: 0, attributes: {} }];
  const skuSpecs = buildSkuSpecs(skus);
  const externalProductId = dto.externalProductId
    ? boundedText(dto.externalProductId, 255, 'external product ID')
    : undefined;
  return {
    category_leaf_id: categoryId,
    commit: true,
    description: (detailImages.length ? detailImages : mainImages).join('|'),
    freight_id: 0,
    mobile,
    name: dto.title,
    ...(externalProductId ? { outer_product_id: externalProductId } : {}),
    pic: mainImages.join('|'),
    product_type: 0,
    reduce_type: 2,
    spec_name: skuSpecs.dimensions.join('|'),
    spec_prices: canonicalJson(skuSpecs.prices),
    specs: skuSpecs.specs,
    ...(dto.categoryProperties
      ? { product_format_new: serializeCategoryProperties(dto.categoryProperties) }
      : {}),
    ...(dto.qualifications?.length
      ? { quality_list: serializeQualifications(dto.qualifications) }
      : {}),
  };
}

function buildSkuSpecs(skus: PublishProductDto['skus']): {
  dimensions: string[];
  specs: string;
  prices: Array<Record<string, number | string>>;
} {
  const dimensions = uniqueStrings(skus.flatMap((sku) => Object.keys(sku.attributes)));
  const effectiveDimensions = dimensions.length ? dimensions : ['规格'];
  if (effectiveDimensions.length > 3) {
    throw new Error('Douyin product supports at most 3 SKU dimensions');
  }
  effectiveDimensions.forEach((dimension) => assertSafeSpecText(dimension, 'SKU dimension'));

  const valuesByDimension = new Map(
    effectiveDimensions.map((dimension) => [dimension, [] as string[]]),
  );
  const prices = skus.map((sku) => {
    const sourceSkuId = sku.sourceSkuId?.trim();
    if (sourceSkuId && sourceSkuId.length > 128) {
      throw new Error('Douyin external SKU ID is invalid');
    }
    const values = effectiveDimensions.map((dimension) => {
      const value = dimensions.length
        ? sku.attributes[dimension]?.trim()
        : sku.specName.trim() || '默认';
      if (!value) throw new Error(`Douyin SKU is missing dimension ${dimension}`);
      assertSafeSpecText(value, 'SKU value');
      const valuesForDimension = valuesByDimension.get(dimension)!;
      if (!valuesForDimension.includes(value)) valuesForDimension.push(value);
      return value;
    });
    return {
      ...(sourceSkuId ? { outer_sku_id: sourceSkuId } : {}),
      price: toCents(sku.price, 'SKU price'),
      stock_num: toStock(sku.stock),
      ...Object.fromEntries(values.map((value, index) => [`spec_detail_name${index + 1}`, value])),
    };
  });
  const specs = effectiveDimensions
    .map((dimension) => `${dimension}|${valuesByDimension.get(dimension)!.join(',')}`)
    .join('^');
  return { dimensions: effectiveDimensions, specs, prices };
}

function assertSafeSpecText(value: string, label: string): void {
  if (!value.trim() || /[|,^]/.test(value) || value.length > 30) {
    throw new Error(`Douyin ${label} is invalid`);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function safeMessage(message: string | undefined, fallbackCode: number): string {
  const value = message?.trim();
  return value ? value.slice(0, 200) : String(fallbackCode);
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

function formatDouyinTimestamp(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function uniqueHttpUrls(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(isHttpUrl))];
}

function extractHttpUrls(value: string): string[] {
  return value.match(/https?:\/\/[^\s"'<>|]+/g) ?? [];
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function toCents(value: number, label: string): number {
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error(`Douyin ${label} must be positive`);
  }
  return cents;
}

function toStock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Douyin SKU stock must be a non-negative integer');
  }
  return value;
}

function positiveNumericId(value: string, label: string): string {
  const id = value.trim();
  if (!/^\d+$/.test(id) || id === '0' || id.length > 32) {
    throw new Error(`Douyin ${label} must be a positive numeric string`);
  }
  return id;
}

function positiveSafeIntegerId(value: string, label: string): string {
  const id = positiveNumericId(value, label);
  if (!Number.isSafeInteger(Number(id))) {
    throw new Error(`Douyin ${label} must be a positive safe integer`);
  }
  return id;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function validateInventoryResults(value: unknown, expectedUniqIds: string[]): void {
  if (!Array.isArray(value) || value.length !== expectedUniqIds.length) {
    throw new InvalidInventoryMutationResponseError(
      'Douyin inventory sync returned an invalid response',
    );
  }
  const expected = new Set(expectedUniqIds);
  const results = new Map<string, number>();
  for (const itemValue of value) {
    const item = recordValue(itemValue);
    const uniqId = stringValue(item?.uniq_id);
    const statusCode = inventoryStatusCode(item?.status_code);
    if (!uniqId || !expected.has(uniqId) || results.has(uniqId) || statusCode === null) {
      throw new InvalidInventoryMutationResponseError(
        'Douyin inventory sync returned an invalid response',
      );
    }
    results.set(uniqId, statusCode);
  }
  for (const uniqId of expectedUniqIds) {
    if (results.get(uniqId) !== 0) {
      throw new Error(`Douyin inventory sync failed for item ${uniqId}`);
    }
  }
}

function inventoryStatusCode(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
}

class InvalidInventoryMutationResponseError extends Error {}

function mutationResultIsUnknown(error: unknown, operation: string): boolean {
  if (!(error instanceof Error)) return false;
  const httpStatus = new RegExp(`^Douyin ${operation} failed \\(HTTP (\\d{3})\\)$`).exec(
    error.message,
  )?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 408 || status === 429 || status >= 500;
  }
  return (
    error.message === `Douyin ${operation} request failed` ||
    error.message === `Douyin ${operation} returned an invalid response`
  );
}

function validDouyinTitle(value: unknown): string {
  const title = stringValue(value).trim();
  const units = [...title].reduce(
    (total, character) => total + (/^[\x00-\x7f]$/.test(character) ? 1 : 2),
    0,
  );
  if (!title || /[\r\n]/.test(title) || units < 16 || units > 60) {
    throw new Error('Douyin product title is invalid');
  }
  return title;
}

function mapCategoryNode(value: unknown, requestedParentId: string): CategoryNode {
  const record = recordValue(value);
  const id = positiveSafeIntegerId(stringValue(record?.id), 'category ID');
  const name = boundedText(stringValue(record?.name), 128, 'category name');
  const parentIdValue = stringValue(record?.parent_id).trim() || requestedParentId;
  const level = optionalInteger(record?.level);
  const isLeaf = booleanValue(record?.is_leaf);
  const enabled = booleanValue(record?.enable);
  const channel = optionalInteger(record?.channel);
  if (
    !record ||
    level === null ||
    level < 1 ||
    level > 10 ||
    isLeaf === null ||
    enabled === null ||
    (channel !== null && channel !== 0 && channel !== 1)
  ) {
    throw new Error('Douyin category tree returned an invalid response');
  }
  if (requestedParentId !== '0' && parentIdValue !== requestedParentId) {
    throw new Error('Douyin category tree returned an invalid parent');
  }
  return {
    id,
    name,
    ...(parentIdValue !== '0' ? { parentId: parentIdValue } : {}),
    isLeaf,
    level,
    enabled,
    channel: channel ?? 0,
  };
}

function mapCategoryRecommendations(
  value: unknown,
): CategoryRecommendationResult['recommendations'] {
  const recommendations: CategoryRecommendationResult['recommendations'] = [];
  const seen = new Set<string>();
  for (const itemValue of arrayValue(value)) {
    const item = recordValue(itemValue);
    const detail = recordValue(item?.category_detail);
    if (!item || !detail) continue;
    const levels = [
      [detail.first_cid, detail.first_cname],
      [detail.second_cid, detail.second_cname],
      [detail.third_cid, detail.third_cname],
      [detail.fourth_cid, detail.fourth_cname],
    ]
      .map(([idValue, nameValue]) => ({
        id: stringValue(idValue).trim(),
        name: stringValue(nameValue).trim(),
      }))
      .filter((level) => level.id && level.name);
    const leaf = levels.at(-1);
    if (!leaf || !/^\d+$/.test(leaf.id) || seen.has(leaf.id)) continue;
    seen.add(leaf.id);
    const qualificationStatus = optionalInteger(item.qualification_status);
    recommendations.push({
      categoryId: leaf.id,
      categoryName: leaf.name.slice(0, 128),
      categoryPath: levels
        .map((level) => level.name)
        .join('/')
        .slice(0, 512),
      qualificationStatus:
        qualificationStatus === 0 || qualificationStatus === 1 || qualificationStatus === 2
          ? qualificationStatus
          : null,
    });
    if (recommendations.length === 3) break;
  }
  return recommendations;
}

function mapProductState(
  status: number | null,
  checkStatus: number | null,
): PlatformProductState['state'] {
  if (checkStatus === 1) return 'draft';
  if (checkStatus === 2) return 'reviewing';
  if (checkStatus === 4) return 'rejected';
  if (checkStatus === 5) return 'blocked';
  if (checkStatus === 7) return 'approved_pending_online';
  if (checkStatus === 3) {
    if (status === 0) return 'online';
    if (status === 1) return 'offline';
    if (status === 2) return 'deleted';
  }
  return 'unknown';
}

function assertProductDetailId(data: DouyinProductDetailData, productId: string): void {
  const returnedProductId = stringValue(data.product_id_str ?? data.product_id).trim();
  if (!returnedProductId || returnedProductId !== productId) {
    throw new Error('Douyin product detail returned a mismatched product ID');
  }
}

function parseProductPrices(value: unknown): PlatformProductPriceState['items'] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Douyin product detail returned no SKU prices');
  }
  const seen = new Set<string>();
  const items = value.map((itemValue) => {
    const item = recordValue(itemValue);
    if (!item) throw new Error('Douyin product detail returned an invalid SKU price');
    const sourceSkuId = strictExternalSkuId(item.outer_sku_id);
    if (seen.has(sourceSkuId)) {
      throw new Error(`Douyin product detail returned duplicate external SKU ID: ${sourceSkuId}`);
    }
    seen.add(sourceSkuId);
    return {
      sourceSkuId,
      priceCents: positiveInteger(item.price, 'SKU price in cents'),
    };
  });
  return items.sort((left, right) =>
    left.sourceSkuId < right.sourceSkuId ? -1 : left.sourceSkuId > right.sourceSkuId ? 1 : 0,
  );
}

function parseProductInventory(value: unknown): PlatformProductInventoryState['items'] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Douyin product detail returned no SKU inventory');
  }
  const seen = new Set<string>();
  const items = value.map((itemValue) => {
    const item = recordValue(itemValue);
    if (!item) throw new Error('Douyin product detail returned invalid SKU inventory');
    const sourceSkuId = strictExternalSkuId(item.outer_sku_id);
    if (seen.has(sourceSkuId)) {
      throw new Error(`Douyin product detail returned duplicate external SKU ID: ${sourceSkuId}`);
    }
    seen.add(sourceSkuId);
    return {
      sourceSkuId,
      stock: nonNegativeInteger(item.stock_num, 'SKU stock'),
    };
  });
  return items.sort((left, right) =>
    left.sourceSkuId < right.sourceSkuId ? -1 : left.sourceSkuId > right.sourceSkuId ? 1 : 0,
  );
}

function mapCategoryAttribute(value: unknown): CategoryAttr[] {
  const record = recordValue(value);
  const id = stringValue(record?.property_id).trim();
  const name = stringValue(record?.property_name ?? record?.name).trim();
  const status = optionalInteger(record?.status);
  const propertyType = optionalInteger(record?.property_type);
  if (!record || !/^\d+$/.test(id) || !name || status === 1 || propertyType === 2) return [];

  const rawType = stringValue(record.type).trim();
  const options = arrayValue(record.options).flatMap((optionValue) => {
    const option = recordValue(optionValue);
    const optionId = stringValue(option?.value_id ?? option?.value).trim();
    const optionName = stringValue(option?.name).trim();
    return /^\d+$/.test(optionId) && optionName ? [{ id: optionId, name: optionName }] : [];
  });
  const supportsCustom = optionalInteger(record.diy_type) === 1;
  const supportedTypes = new Set(['text', 'select', 'multi_select']);
  const complexReasons = [
    arrayValue(record.measure_templates).length > 0 ? '度量衡属性' : '',
    booleanValue(record.has_sub_property) === true ? '级联属性' : '',
    booleanValue(recordValue(record.property_pic_rule)?.required) === true ? '必填属性图' : '',
    !supportedTypes.has(rawType) ? `未知输入类型 ${rawType || 'unknown'}` : '',
    (rawType === 'text' || rawType === 'select' || rawType === 'multi_select') &&
    options.length === 0 &&
    !supportsCustom
      ? '平台未返回可填写选项且不支持自定义'
      : '',
  ].filter(Boolean);
  const inputType = complexReasons.length ? 'unsupported' : (rawType as CategoryAttr['inputType']);
  const maxSelections = optionalInteger(record.multi_select_max);
  return [
    {
      id,
      name: name.slice(0, 128),
      required: optionalInteger(record.require) === 1,
      multiValue: rawType === 'multi_select',
      inputType,
      supportsCustom,
      ...(maxSelections && maxSelections > 0 ? { maxSelections } : {}),
      ...(complexReasons.length ? { unsupportedReason: complexReasons.join('、') } : {}),
      ...(options.length ? { values: options } : {}),
    },
  ];
}

function mapCategoryQualification(value: unknown): CategoryQualification {
  const record = recordValue(value);
  const key = stringValue(record?.key).trim();
  const name = stringValue(record?.name).trim();
  const required = booleanValue(record?.is_required);
  if (!record || !key || !name || required === null) {
    throw new Error('Douyin category qualifications returned an invalid response');
  }

  const hints = uniqueStrings(
    arrayValue(record.text_list)
      .map((item) => stringValue(item).trim())
      .filter(Boolean),
  ).map((item) => item.slice(0, 500));
  const rules: CategoryQualification['rules'] = [];
  const unsupportedReasons: string[] = [];
  for (const ruleValue of arrayValue(record.matchable_rule)) {
    const rule = recordValue(ruleValue);
    const ruleRequired = booleanValue(rule?.is_qualification_required);
    const clauseRecord = recordValue(rule?.rule_clause);
    if (!rule || ruleRequired === null || !clauseRecord) {
      unsupportedReasons.push('动态必填规则结构无法识别');
      continue;
    }
    const clauses: CategoryQualification['rules'][number]['clauses'] = [];
    for (const [propertyId, clauseValue] of Object.entries(clauseRecord)) {
      const clause = recordValue(clauseValue);
      const propertyValues = uniqueStrings(
        arrayValue(clause?.property_values)
          .map((item) => stringValue(item).trim())
          .filter(Boolean),
      );
      const operand = qualificationOperand(clause?.operand_str);
      if (!/^\d+$/.test(propertyId) || !clause || propertyValues.length === 0 || !operand) {
        unsupportedReasons.push('动态必填规则条件无法识别');
        continue;
      }
      clauses.push({ propertyId, propertyValues, operand });
    }
    if (clauses.length !== Object.keys(clauseRecord).length) continue;
    if (clauses.length === 0) {
      if (ruleRequired) unsupportedReasons.push('动态必填规则缺少属性条件');
      continue;
    }
    rules.push({ clauses, required: ruleRequired });
  }
  if (!/^\d+$/.test(key)) unsupportedReasons.push('资质 key 无法映射为 quality_id');

  return {
    key: key.slice(0, 64),
    name: name.slice(0, 128),
    hints,
    required,
    rules,
    ...(unsupportedReasons.length
      ? { unsupportedReason: uniqueStrings(unsupportedReasons).join('、') }
      : {}),
  };
}

function qualificationOperand(
  value: unknown,
): CategoryQualification['rules'][number]['clauses'][number]['operand'] | null {
  const operand = stringValue(value).trim().toLowerCase();
  if (['=', '==', 'equal', 'equals', '等于'].includes(operand)) return 'equal';
  if (['!=', '<>', 'not_equal', 'not equal', 'not equals', '不等于'].includes(operand)) {
    return 'not_equal';
  }
  return null;
}

function serializeCategoryProperties(properties: CategoryPropertyMap): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const [propertyId, rawValues] of Object.entries(properties)) {
    if (!/^\d+$/.test(propertyId) || !Array.isArray(rawValues) || rawValues.length === 0) {
      throw new Error('Douyin category properties are invalid');
    }
    result[propertyId] = rawValues.map((rawValue) => {
      const value = Math.trunc(rawValue.value);
      const name = boundedText(rawValue.name, 128, 'category property value name');
      if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (rawValue.diyType !== 0 && rawValue.diyType !== 1)
      ) {
        throw new Error('Douyin category property value is invalid');
      }
      if ((rawValue.diyType === 0 && value <= 0) || (rawValue.diyType === 1 && value !== 0)) {
        throw new Error('Douyin category property value is invalid');
      }
      return { diy_type: rawValue.diyType, name, value };
    });
  }
  return result;
}

function serializeQualifications(
  qualifications: NonNullable<PublishProductDto['qualifications']>,
): unknown[] {
  const seen = new Set<string>();
  return qualifications.map((qualification) => {
    const qualityKey = boundedText(qualification.qualityKey, 64, 'qualification key');
    const qualityName = boundedText(qualification.qualityName, 128, 'qualification name');
    const qualityId = positiveInteger(qualification.qualityId, 'qualification ID');
    if (seen.has(qualityKey)) throw new Error('Douyin qualifications contain duplicate keys');
    seen.add(qualityKey);
    if (!Array.isArray(qualification.attachments) || qualification.attachments.length === 0) {
      throw new Error('Douyin qualification requires at least one attachment');
    }
    return {
      quality_key: qualityKey,
      quality_name: qualityName,
      ...(qualification.qualityContentName
        ? {
            quality_content_name: boundedText(
              qualification.qualityContentName,
              128,
              'qualification content name',
            ),
          }
        : {}),
      quality_id: qualityId,
      quality_attachments: qualification.attachments.map((attachment) => {
        if (attachment.mediaType !== 1) {
          throw new Error('Douyin qualification attachment media type is invalid');
        }
        const url = boundedText(attachment.url, 2048, 'qualification attachment URL');
        try {
          if (new URL(url).protocol !== 'https:') throw new Error('invalid protocol');
        } catch {
          throw new Error('Douyin qualification attachment URL is invalid');
        }
        return { media_type: 1, url };
      }),
    };
  });
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function optionalInteger(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const number = optionalInteger(value);
  return number === null ? fallback : Math.min(maximum, Math.max(minimum, number));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parsePage(cursor: string | undefined): number {
  if (!cursor) return 0;
  const page = Number(cursor);
  return Number.isSafeInteger(page) && page >= 0 ? page : 0;
}

function mapOrder(value: unknown, decrypted: Map<string, string>): PlatformOrder {
  const order = recordValue(value);
  const platformOrderId = stringValue(order?.order_id).trim();
  if (!order || !platformOrderId) {
    throw new Error('Douyin order response contained an invalid order');
  }
  if (!Array.isArray(order.sku_order_list) || order.sku_order_list.length === 0) {
    throw new Error('Douyin order response contained an invalid child order list');
  }

  const skuList = order.sku_order_list.map(mapSku);
  const platformOrderItemIds = new Set(skuList.map((sku) => sku.platformOrderItemId));
  if (platformOrderItemIds.size !== skuList.length) {
    throw new Error('Douyin order response contained duplicate child orders');
  }
  const amountCents = requiredNonNegativeInteger(
    order.pay_amount ?? order.order_amount,
    'Douyin order response contained invalid order values',
  );
  const payTime =
    optionalPositiveInteger(
      order.pay_time,
      'Douyin order response contained invalid order values',
    ) ??
    requiredPositiveInteger(
      order.create_time,
      'Douyin order response contained invalid order values',
    );
  const status = mapOrderStatus(stringValue(order.order_status));
  const shipmentPackages = mapShipmentPackages(order.logistics_info, status, platformOrderItemIds);
  const paid = status === 'paid';
  const decryptionAuthId = paid ? platformOrderId : undefined;
  const receiverAddressDetail = mapReceiverAddress(
    paid ? order.post_addr : order.mask_post_addr,
    decrypted,
    decryptionAuthId,
  );
  return {
    amount: amountCents / 100,
    buyerNick: stringValue(order.user_nick_name ?? order.open_id),
    paidAt: new Date(payTime * 1000),
    platformOrderId,
    receiverAddress: formatAddress(receiverAddressDetail),
    receiverAddressDetail,
    receiverName: resolveSensitiveValue(
      paid ? order.encrypt_post_receiver : order.mask_post_receiver,
      decrypted,
      decryptionAuthId,
    ),
    receiverPhone: resolveSensitiveValue(
      paid ? order.encrypt_post_tel : order.mask_post_tel,
      decrypted,
      decryptionAuthId,
    ),
    shipmentPackages,
    skuList,
    status,
  };
}

function mapShipmentPackages(
  value: unknown,
  orderStatus: string,
  platformOrderItemIds: Set<string>,
): PlatformShipmentPackage[] {
  const requiresSnapshot = orderStatus === 'shipped' || orderStatus === 'received';
  if (value === undefined || value === null) {
    if (requiresSnapshot) {
      throw new Error('Douyin order response did not contain a logistics snapshot');
    }
    return [];
  }
  if (!Array.isArray(value) || (requiresSnapshot && value.length === 0)) {
    throw new Error('Douyin order response contained an invalid logistics snapshot');
  }

  const deliveryIds = new Set<string>();
  const packageItemKeys = new Set<string>();
  const routedOrderItemIds = new Set<string>();
  return value.map((packageValue) => {
    const pack = recordValue(packageValue);
    if (!pack) throw new Error('Douyin order response contained an invalid logistics package');
    const deliveryId = strictShipmentText(pack.delivery_id, 64, 'logistics delivery ID');
    const trackingNo = strictShipmentText(pack.tracking_no, 64, 'logistics code');
    const companyCode = strictCompanyCode(pack.company);
    const carrier = strictShipmentText(pack.company_name, 64, 'logistics company');
    if (deliveryIds.has(deliveryId)) {
      throw new Error('Douyin order response contained duplicate logistics delivery IDs');
    }
    deliveryIds.add(deliveryId);
    if (!Array.isArray(pack.product_info) || pack.product_info.length === 0) {
      throw new Error('Douyin order response contained a logistics package without products');
    }

    const packageOrderItemIds = new Set<string>();
    const items = pack.product_info.map((productValue) => {
      const product = recordValue(productValue);
      if (!product) {
        throw new Error('Douyin order response contained an invalid logistics product');
      }
      const platformOrderItemId = strictShipmentText(
        product.sku_order_id,
        64,
        'logistics child order ID',
      );
      const quantity = requiredPositiveInteger(
        product.product_count,
        'Douyin order response contained an invalid logistics product quantity',
      );
      if (!platformOrderItemIds.has(platformOrderItemId)) {
        throw new Error('Douyin order response contained logistics for an unknown child order');
      }
      if (packageOrderItemIds.has(platformOrderItemId)) {
        throw new Error(
          'Douyin order response contained duplicate products in a logistics package',
        );
      }
      if (routedOrderItemIds.has(platformOrderItemId)) {
        throw new Error('Douyin order response routed one child order through multiple packages');
      }
      packageOrderItemIds.add(platformOrderItemId);
      routedOrderItemIds.add(platformOrderItemId);
      return { platformOrderItemId, quantity };
    });
    const itemsKey = shipmentItemsKey(items);
    if (packageItemKeys.has(itemsKey)) {
      throw new Error('Douyin order response contained duplicate logistics package item groups');
    }
    packageItemKeys.add(itemsKey);
    return { deliveryId, trackingNo, companyCode, carrier, items };
  });
}

function mapSku(value: unknown): PlatformOrder['skuList'][number] {
  const sku = recordValue(value);
  const skuId = stringValue(sku?.sku_id).trim();
  const platformOrderItemId = stringValue(sku?.sku_order_id ?? sku?.order_id).trim();
  if (!sku || !skuId || !platformOrderItemId) {
    throw new Error('Douyin order response contained an invalid child order');
  }
  const invalidValues = 'Douyin order response contained invalid child order values';
  const quantity = requiredPositiveInteger(sku.item_num, invalidValues);
  const originAmount = optionalNonNegativeInteger(sku.origin_amount, invalidValues);
  const totalAmount = optionalNonNegativeInteger(sku.pay_amount ?? sku.order_amount, invalidValues);
  if (originAmount === null && totalAmount === null) throw new Error(invalidValues);
  const unitPrice = originAmount ?? totalAmount! / quantity;
  const afterSale = mapAfterSaleInfo(sku.after_sale_info);
  return {
    ...afterSale,
    platformOrderItemId,
    platformProductId: stringValue(sku.product_id_str ?? sku.product_id) || undefined,
    quantity,
    skuId,
    sourceSkuId: stringValue(sku.out_sku_id ?? sku.outer_sku_id) || undefined,
    specs: mapSkuSpecs(sku.spec ?? sku.sku_specs),
    title: stringValue(sku.product_name),
    unitPrice: unitPrice / 100,
  };
}

function mapAfterSaleInfo(
  value: unknown,
): Pick<PlatformOrder['skuList'][number], 'afterSaleStatus' | 'afterSaleType' | 'refundStatus'> {
  if (value === undefined || value === null) return {};
  const afterSale = recordValue(value);
  const invalidValues = 'Douyin order response contained invalid child after-sale values';
  if (!afterSale) throw new Error(invalidValues);
  const afterSaleStatus = optionalNonNegativeResponseInteger(
    afterSale.after_sale_status,
    invalidValues,
  );
  const afterSaleType = optionalNonNegativeResponseInteger(
    afterSale.after_sale_type,
    invalidValues,
  );
  const refundStatus = optionalNonNegativeResponseInteger(afterSale.refund_status, invalidValues);
  return {
    ...(afterSaleStatus === undefined ? {} : { afterSaleStatus }),
    ...(afterSaleType === undefined ? {} : { afterSaleType }),
    ...(refundStatus === undefined ? {} : { refundStatus }),
  };
}

function mapSkuSpecs(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const specs = value.flatMap((entry) => {
    const record = recordValue(entry);
    const name = stringValue(record?.name);
    const specValue = stringValue(record?.value);
    return name && specValue ? ([[name, specValue]] as Array<[string, string]>) : [];
  });
  return specs.length ? Object.fromEntries(specs) : undefined;
}

function mapOrderStatus(status: string): string {
  if (status === '105' || status === '2') return 'paid';
  if (status === '101' || status === '3') return 'shipped';
  if (status === '5') return 'received';
  if (status === '4') return 'closed';
  return status || 'unknown';
}

function mapReceiverAddress(
  value: unknown,
  decrypted: Map<string, string>,
  decryptionAuthId?: string,
): PlatformOrder['receiverAddressDetail'] | undefined {
  const address = recordValue(value);
  if (!address) return undefined;
  const province = nestedName(address.province);
  const city = nestedName(address.city);
  const area = nestedName(address.town ?? address.area);
  const detail = resolveSensitiveValue(
    address.encrypt_detail ?? address.detail,
    decrypted,
    decryptionAuthId,
  );
  if (!province || !city || !area || !detail) return undefined;
  return {
    province,
    city,
    area,
    town: nestedName(address.street) || undefined,
    detail,
    postalCode: stringValue(address.post_code ?? address.postCode) || undefined,
  };
}

function nestedName(value: unknown): string {
  return stringValue(recordValue(value)?.name ?? value);
}

function formatAddress(value: PlatformOrder['receiverAddressDetail']): string {
  if (!value) return '';
  return [value.province, value.city, value.area, value.town, value.detail]
    .filter(Boolean)
    .join('');
}

function validatePreviousShipmentPackages(value: ShipPackageDto[]): ShipPackageDto[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Douyin shipment replacement requires at least one previous package');
  }
  const routedOrderItemIds = new Set<string>();
  const packageItemKeys = new Set<string>();
  return value.map((packageValue) => {
    const pack = recordValue(packageValue);
    if (!pack) throw new Error('Douyin previous shipment package is invalid');
    const items = validateShipmentItems(pack.items, routedOrderItemIds, 'previous');
    assertUniqueShipmentItemGroup(items, packageItemKeys, 'previous');
    return {
      trackingNo: strictShipmentText(pack.trackingNo, 64, 'logistics code'),
      carrier: strictShipmentText(pack.carrier, 64, 'logistics company'),
      items,
    };
  });
}

function validateTargetShipmentPackages(value: ShipPackageDto[]): ShipPackageDto[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Douyin shipment replacement requires at least one target package');
  }
  const routedOrderItemIds = new Set<string>();
  const packageItemKeys = new Set<string>();
  return value.map((packageValue) => {
    const pack = recordValue(packageValue);
    if (!pack) throw new Error('Douyin target shipment package is invalid');
    const items = validateShipmentItems(pack.items, routedOrderItemIds, 'target');
    assertUniqueShipmentItemGroup(items, packageItemKeys, 'target');
    return {
      trackingNo: strictShipmentText(pack.trackingNo, 64, 'logistics code'),
      carrier: strictShipmentText(pack.carrier, 64, 'logistics company'),
      items,
    };
  });
}

function validateShipmentItems(
  value: unknown,
  routedOrderItemIds: Set<string>,
  packageKind: 'previous' | 'target',
): PlatformShipmentPackage['items'] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Douyin ${packageKind} shipment package requires at least one order item`);
  }
  const packageOrderItemIds = new Set<string>();
  return value.map((itemValue) => {
    const item = recordValue(itemValue);
    if (!item) throw new Error(`Douyin ${packageKind} shipment package item is invalid`);
    const platformOrderItemId = strictShipmentText(
      item.platformOrderItemId,
      64,
      'shipped order ID',
    );
    const quantity = positiveInteger(item.quantity, 'shipped quantity');
    if (packageOrderItemIds.has(platformOrderItemId)) {
      throw new Error(`Douyin ${packageKind} shipment package contains duplicate order items`);
    }
    if (routedOrderItemIds.has(platformOrderItemId)) {
      throw new Error(
        `Douyin ${packageKind} shipment packages route one order item through multiple packages`,
      );
    }
    packageOrderItemIds.add(platformOrderItemId);
    routedOrderItemIds.add(platformOrderItemId);
    return { platformOrderItemId, quantity };
  });
}

function assertUniqueShipmentItemGroup(
  items: PlatformShipmentPackage['items'],
  packageItemKeys: Set<string>,
  packageKind: 'previous' | 'target',
): void {
  const itemsKey = shipmentItemsKey(items);
  if (packageItemKeys.has(itemsKey)) {
    throw new Error(`Douyin ${packageKind} shipment packages contain duplicate item groups`);
  }
  packageItemKeys.add(itemsKey);
}

function shipmentItemsKey(items: PlatformShipmentPackage['items']): string {
  return JSON.stringify(
    items
      .map((item) => [item.platformOrderItemId, item.quantity] as const)
      .sort(
        ([leftId, leftQuantity], [rightId, rightQuantity]) =>
          leftId.localeCompare(rightId) || leftQuantity - rightQuantity,
      ),
  );
}

function shipmentPackagesByItems<T extends { items: PlatformShipmentPackage['items'] }>(
  packages: T[],
): Map<string, T> {
  return new Map(packages.map((pack) => [shipmentItemsKey(pack.items), pack]));
}

function sameKeys(
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
): boolean {
  return left.size === right.size && [...left.keys()].every((key) => right.has(key));
}

function sameShipmentRoute(
  left: Pick<PlatformShipmentPackage, 'trackingNo' | 'companyCode'>,
  right: Pick<PlatformShipmentPackage, 'trackingNo' | 'companyCode'>,
): boolean {
  return left.trackingNo === right.trackingNo && left.companyCode === right.companyCode;
}

function shipmentSnapshotMatchesTarget(
  currentPackages: PlatformShipmentPackage[],
  targetPackages: Array<ShipPackageDto & { companyCode: string }>,
): boolean {
  const currentByItems = shipmentPackagesByItems(currentPackages);
  const targetByItems = shipmentPackagesByItems(targetPackages);
  if (!sameKeys(currentByItems, targetByItems)) return false;
  return [...targetByItems].every(([itemsKey, target]) =>
    sameShipmentRoute(currentByItems.get(itemsKey)!, target),
  );
}

function directCarrierCode(carrier: string): string | undefined {
  const value = carrier.trim();
  const aliases: Record<string, string> = {
    顺丰: 'shunfeng',
    顺丰快递: 'shunfeng',
    顺丰速运: 'shunfeng',
  };
  const code = aliases[value] ?? value;
  return /^[a-z0-9_-]+$/i.test(code) ? code : undefined;
}

function normalizeCarrierName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s·・·]+/g, '')
    .replace(/(快递|速递|速运|物流|快运|运输)$/u, '');
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  const text = stringValue(value);
  if (!text || text.length > maxLength) {
    throw new Error(`Douyin ${label} is invalid`);
  }
  return text;
}

function strictExternalSkuId(value: unknown): string {
  const sourceSkuId = stringValue(value).trim();
  if (!sourceSkuId || sourceSkuId.length > 128 || /[\u0000-\u001f\u007f]/.test(sourceSkuId)) {
    throw new Error('Douyin external SKU ID is invalid');
  }
  return sourceSkuId;
}

function strictShipmentText(value: unknown, maxLength: number, label: string): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  ) {
    throw new Error(`Douyin ${label} is invalid`);
  }
  const text = String(value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`Douyin ${label} is invalid`);
  }
  return text;
}

function strictCompanyCode(value: unknown): string {
  const code = strictShipmentText(value, 64, 'logistics company code');
  if (!/^[a-z0-9_-]+$/i.test(code)) {
    throw new Error('Douyin logistics company code is invalid');
  }
  return code;
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Douyin ${label} is invalid`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Douyin ${label} is invalid`);
  }
  return number;
}

function decryptionKey(authId: string, cipherText: string): string {
  return `${authId}\u0000${cipherText}`;
}

function resolveSensitiveValue(
  value: unknown,
  decrypted: Map<string, string>,
  decryptionAuthId?: string,
): string {
  const text = stringValue(value);
  if (!text) return '';
  if (!decryptionAuthId) return text;
  const resolved = decrypted.get(decryptionKey(decryptionAuthId, text));
  if (!resolved) throw new Error('Douyin order contains an undecrypted sensitive field');
  return resolved;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function requiredPositiveInteger(value: unknown, errorMessage: string): number {
  const number = numericValue(value);
  if (number === null || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(errorMessage);
  }
  return number;
}

function optionalPositiveInteger(value: unknown, errorMessage: string): number | null {
  if (value === undefined || value === null || value === 0 || value === '0') return null;
  return requiredPositiveInteger(value, errorMessage);
}

function requiredNonNegativeInteger(value: unknown, errorMessage: string): number {
  const number = optionalNonNegativeInteger(value, errorMessage);
  if (number === null) throw new Error(errorMessage);
  return number;
}

function optionalNonNegativeInteger(value: unknown, errorMessage: string): number | null {
  if (value === undefined || value === null) return null;
  const number = numericValue(value);
  if (number === null || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(errorMessage);
  }
  return number;
}

function optionalNonNegativeResponseInteger(
  value: unknown,
  errorMessage: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = numericValue(value);
  if (number === null || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(errorMessage);
  }
  return number;
}

function numericValue(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
