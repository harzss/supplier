import type { PlatformType, TokenSet } from '@supplier/shared-types';
import { BasePlatformAdapter } from '../adapter';
import type {
  AdapterConfig,
  CategoryAttr,
  CategoryNode,
  CategoryQualification,
  CategoryRecommendationInput,
  CategoryRecommendationResult,
  OrderQuery,
  PlatformOrder,
  PlatformProductInventoryState,
  PlatformProductPriceState,
  PlatformProductSkuRules,
  PlatformProductSkuRulesQuery,
  PlatformProductSkuState,
  PlatformProductState,
  PlatformProductTitleState,
  PublishProductDto,
  PublishResult,
  ReplaceProductSkusDto,
  ShipDto,
  ShipPackagesDto,
  SyncInventoryDto,
  UpdateProductDto,
  UpdateProductPriceDto,
  UpdateProductTitleDto,
} from '../types';

const DEFAULT_CONFIG: AdapterConfig = {
  appKey: 'mock',
  appSecret: 'mock',
  redirectUri: 'https://mock.local/callback',
  sandbox: true,
};

const MOCK_PRODUCT_PRICES = new Map<string, Map<string, number>>();
const MOCK_PRODUCT_INVENTORY = new Map<string, Map<string, number>>();
const MOCK_PRODUCT_STATES = new Map<string, PlatformProductState>();
const MOCK_PRODUCT_TITLES = new Map<string, string>();
const MOCK_PRODUCT_SKUS = new Map<
  string,
  Pick<PlatformProductSkuState, 'categoryId' | 'productType' | 'startSaleType' | 'items'>
>();

/**
 * Mock 平台适配器：模拟发布 / 订单 / 发货。
 * 用于在无真实平台 OAuth 资质时跑通主流程；真实接入时替换为对应平台 adapter，上层无需改动。
 */
export class MockPlatformAdapter extends BasePlatformAdapter {
  readonly platform: PlatformType;

  constructor(platform: PlatformType, config: AdapterConfig = DEFAULT_CONFIG) {
    super(config);
    this.platform = platform;
  }

  buildAuthUrl(state: string): string {
    return `https://mock.${this.platform}.local/authorize?state=${encodeURIComponent(state)}`;
  }

  async exchangeToken(code: string): Promise<TokenSet> {
    return {
      accessToken: `mock-access-${this.platform}-${code}`,
      refreshToken: `mock-refresh-${this.platform}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    };
  }

  async refreshToken(_refreshToken: string): Promise<TokenSet> {
    return {
      accessToken: `mock-access-${this.platform}-${Date.now()}`,
      refreshToken: `mock-refresh-${this.platform}`,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    };
  }

  async publishProduct(_token: string, dto: PublishProductDto): Promise<PublishResult> {
    const id = `${this.platform}-${Date.now()}-${hashTitle(dto.title)}`;
    storeProductPrices(this.platform, id, dto.skus);
    storeProductInventory(this.platform, id, dto.skus);
    storeProductSkus(this.platform, id, dto);
    MOCK_PRODUCT_TITLES.set(mockProductKey(this.platform, id), dto.title);
    MOCK_PRODUCT_STATES.set(mockProductKey(this.platform, id), onlineMockProductState());
    return { platformProductId: id, url: `https://mock.${this.platform}.shop/item/${id}` };
  }

  async updateProduct(_token: string, dto: UpdateProductDto): Promise<void> {
    storeProductPrices(this.platform, dto.platformProductId, dto.skus);
    storeProductInventory(this.platform, dto.platformProductId, dto.skus);
    storeProductSkus(this.platform, dto.platformProductId, dto);
    MOCK_PRODUCT_TITLES.set(mockProductKey(this.platform, dto.platformProductId), dto.title);
  }

  async updateProductTitle(_token: string, dto: UpdateProductTitleDto): Promise<void> {
    const key = mockProductKey(this.platform, dto.platformProductId);
    if (!MOCK_PRODUCT_STATES.has(key) || !MOCK_PRODUCT_TITLES.has(key)) {
      throw new Error('Mock product is unavailable');
    }
    MOCK_PRODUCT_TITLES.set(key, validMockTitle(this.platform, dto.title));
  }

  async getProductTitle(_token: string, productId: string): Promise<PlatformProductTitleState> {
    const key = mockProductKey(this.platform, productId);
    const title = MOCK_PRODUCT_TITLES.get(key);
    if (!title) throw new Error('Mock product title is unavailable');
    return { ...mockProductState(key), title };
  }

  async updateProductPrice(_token: string, dto: UpdateProductPriceDto): Promise<void> {
    const sourceSkuId = validMockSkuId(dto.sourceSkuId);
    const priceCents = validMockPrice(dto.priceCents);
    const key = mockProductKey(this.platform, dto.platformProductId);
    const skuState = MOCK_PRODUCT_SKUS.get(key);
    const sku = skuState?.items.find((item) => item.platformSkuKey === sourceSkuId);
    if (skuState && !sku) throw new Error('Mock product SKU is unavailable');
    const prices = MOCK_PRODUCT_PRICES.get(key) ?? new Map<string, number>();
    prices.set(sourceSkuId, priceCents);
    MOCK_PRODUCT_PRICES.set(key, prices);
    if (sku) sku.priceCents = priceCents;
  }

  async getProductPrices(_token: string, productId: string): Promise<PlatformProductPriceState> {
    const key = mockProductKey(this.platform, productId);
    const prices = MOCK_PRODUCT_PRICES.get(key);
    if (!prices?.size) throw new Error('Mock product prices are unavailable');
    return {
      ...mockProductState(key),
      items: [...prices]
        .map(([sourceSkuId, priceCents]) => ({ sourceSkuId, priceCents }))
        .sort((left, right) =>
          left.sourceSkuId < right.sourceSkuId ? -1 : left.sourceSkuId > right.sourceSkuId ? 1 : 0,
        ),
    };
  }

  async getProductState(_token: string, productId: string): Promise<PlatformProductState> {
    return mockProductState(mockProductKey(this.platform, productId));
  }

  async getProductInventory(
    _token: string,
    productId: string,
  ): Promise<PlatformProductInventoryState> {
    const key = mockProductKey(this.platform, productId);
    const inventory = MOCK_PRODUCT_INVENTORY.get(key);
    if (!inventory?.size) throw new Error('Mock product inventory is unavailable');
    return {
      ...mockProductState(key),
      items: [...inventory]
        .map(([sourceSkuId, stock]) => ({ sourceSkuId, stock }))
        .sort((left, right) =>
          left.sourceSkuId < right.sourceSkuId ? -1 : left.sourceSkuId > right.sourceSkuId ? 1 : 0,
        ),
    };
  }

  async getProductSkuState(_token: string, productId: string): Promise<PlatformProductSkuState> {
    const key = mockProductKey(this.platform, productId);
    const value = MOCK_PRODUCT_SKUS.get(key);
    if (!value?.items.length) throw new Error('Mock product SKUs are unavailable');
    return {
      ...mockProductState(key),
      categoryId: value.categoryId,
      productType: value.productType,
      startSaleType: value.startSaleType,
      items: cloneMockSkuItems(value.items).sort(compareMockSkuItems),
    };
  }

  async getProductSkuRules(
    _token: string,
    query: PlatformProductSkuRulesQuery,
  ): Promise<PlatformProductSkuRules> {
    if (!query.categoryId.trim()) throw new Error('Mock category ID is invalid');
    return {
      maxDimensions: 3,
      maxCombinations: 100,
      maxValuesPerDimension: 100,
      supportsDimensionReordering: true,
      supportsCustomDimensions: true,
      allSkuPicturesRequired: false,
      dimensions: [],
      unsupportedReasons: [],
    };
  }

  async replaceProductSkus(_token: string, dto: ReplaceProductSkusDto): Promise<void> {
    const key = mockProductKey(this.platform, dto.platformProductId);
    const current = MOCK_PRODUCT_SKUS.get(key);
    if (!current) throw new Error('Mock product SKUs are unavailable');
    const items = validateMockSkuReplacement(key, current.items, dto);
    MOCK_PRODUCT_SKUS.set(key, {
      categoryId: current.categoryId,
      productType: current.productType,
      startSaleType: 1,
      items,
    });
    MOCK_PRODUCT_PRICES.set(
      key,
      new Map(items.map((item) => [item.platformSkuKey, item.priceCents])),
    );
    MOCK_PRODUCT_INVENTORY.set(
      key,
      new Map(items.map((item) => [item.platformSkuKey, item.stock])),
    );
    MOCK_PRODUCT_STATES.set(key, { state: 'offline', status: 1, checkStatus: 3 });
  }

  async syncInventory(_token: string, dto: SyncInventoryDto): Promise<void> {
    const key = mockProductKey(this.platform, dto.platformProductId);
    const inventory = new Map(MOCK_PRODUCT_INVENTORY.get(key));
    const seen = new Set<string>();
    const skuState = MOCK_PRODUCT_SKUS.get(key);
    const updates: Array<{ sourceSkuId: string; stock: number }> = [];
    for (const item of dto.items) {
      const sourceSkuId = validMockSkuId(item.sourceSkuId);
      if (seen.has(sourceSkuId)) {
        throw new Error(`Mock duplicate external SKU ID: ${sourceSkuId}`);
      }
      seen.add(sourceSkuId);
      const stock = validMockStock(item.stock);
      if (skuState && !skuState.items.some((sku) => sku.platformSkuKey === sourceSkuId)) {
        throw new Error('Mock product SKU is unavailable');
      }
      updates.push({ sourceSkuId, stock });
    }
    for (const update of updates) {
      inventory.set(update.sourceSkuId, update.stock);
      const sku = skuState?.items.find((item) => item.platformSkuKey === update.sourceSkuId);
      if (sku) sku.stock = update.stock;
    }
    if (inventory.size) MOCK_PRODUCT_INVENTORY.set(key, inventory);
  }

  async onlineProduct(_token: string, productId: string): Promise<void> {
    const key = mockProductKey(this.platform, productId);
    MOCK_PRODUCT_STATES.set(key, onlineMockProductState());
    const skuState = MOCK_PRODUCT_SKUS.get(key);
    if (skuState) skuState.startSaleType = 0;
  }

  async offlineProduct(_token: string, productId: string): Promise<void> {
    const key = mockProductKey(this.platform, productId);
    MOCK_PRODUCT_STATES.set(key, {
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });
    const skuState = MOCK_PRODUCT_SKUS.get(key);
    if (skuState) skuState.startSaleType = 1;
  }

  async getCategoryTree(_token: string): Promise<CategoryNode[]> {
    if (this.platform === 'douyin') {
      return [
        { id: '20000', name: '女装', isLeaf: false, level: 1, enabled: true, channel: 0 },
        {
          id: '20001',
          name: 'T恤',
          parentId: '20000',
          isLeaf: true,
          level: 2,
          enabled: true,
          channel: 0,
        },
        { id: '30000', name: '数码配件', isLeaf: false, level: 1, enabled: true, channel: 0 },
        {
          id: '30001',
          name: '手机壳',
          parentId: '30000',
          isLeaf: true,
          level: 2,
          enabled: true,
          channel: 0,
        },
      ];
    }
    return [
      { id: 'mock-1', name: '女装', isLeaf: false, level: 1 },
      { id: 'mock-1-1', name: 'T恤', parentId: 'mock-1', isLeaf: true, level: 2 },
      { id: 'mock-2', name: '数码配件', isLeaf: false, level: 1 },
      { id: 'mock-2-1', name: '手机壳', parentId: 'mock-2', isLeaf: true, level: 2 },
    ];
  }

  async getCategoryAttributes(_token: string, _categoryId: string): Promise<CategoryAttr[]> {
    if (this.platform !== 'douyin') return [];
    return [
      {
        id: '2176',
        name: '材质',
        required: true,
        multiValue: false,
        inputType: 'select',
        supportsCustom: true,
        values: [
          { id: '111', name: '棉' },
          { id: '112', name: '聚酯纤维' },
        ],
      },
      {
        id: '3001',
        name: '适用场景',
        required: false,
        multiValue: false,
        inputType: 'text',
        supportsCustom: true,
      },
    ];
  }

  async getCategoryQualifications(
    _token: string,
    categoryId: string,
  ): Promise<CategoryQualification[]> {
    if (this.platform !== 'douyin' || categoryId !== '20001') return [];
    return [
      {
        key: '9001',
        name: '质检报告',
        hints: ['如商品已有质检报告，可上传公开 HTTPS 图片地址。'],
        required: false,
        rules: [],
      },
    ];
  }

  async recommendCategories(
    _token: string,
    input: CategoryRecommendationInput,
  ): Promise<CategoryRecommendationResult> {
    const phoneCase = /手机|壳|数码/.test(input.title);
    return {
      recommendId: `mock-${this.platform}`,
      recommendations: [
        phoneCase
          ? {
              categoryId: '30001',
              categoryName: '手机壳',
              categoryPath: '数码配件/手机壳',
              qualificationStatus: 0,
            }
          : {
              categoryId: '20001',
              categoryName: 'T恤',
              categoryPath: '女装/T恤',
              qualificationStatus: 0,
            },
      ],
    };
  }

  async listOrders(_token: string, _query: OrderQuery): Promise<PlatformOrder[]> {
    return [];
  }

  async shipOrder(_token: string, _dto: ShipDto): Promise<void> {
    /* 模拟：无操作 */
  }

  async shipPackages(_token: string, _dto: ShipPackagesDto): Promise<void> {
    /* 模拟：无操作 */
  }

  protected sign(_params: Record<string, unknown>): string {
    return 'mock-signature';
  }
}

function hashTitle(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h * 31 + title.charCodeAt(i)) % 1_000_000;
  }
  return h.toString(36);
}

function storeProductPrices(
  platform: PlatformType,
  productId: string,
  skus: PublishProductDto['skus'],
): void {
  const prices = new Map<string, number>();
  for (const sku of skus) {
    if (!sku.sourceSkuId) continue;
    const sourceSkuId = validMockSkuId(sku.sourceSkuId);
    if (prices.has(sourceSkuId)) throw new Error(`Mock duplicate external SKU ID: ${sourceSkuId}`);
    prices.set(sourceSkuId, validMockPrice(Math.round(sku.price * 100)));
  }
  const key = mockProductKey(platform, productId);
  if (prices.size) MOCK_PRODUCT_PRICES.set(key, prices);
  else MOCK_PRODUCT_PRICES.delete(key);
}

function storeProductInventory(
  platform: PlatformType,
  productId: string,
  skus: PublishProductDto['skus'],
): void {
  const inventory = new Map<string, number>();
  for (const sku of skus) {
    if (!sku.sourceSkuId) continue;
    const sourceSkuId = validMockSkuId(sku.sourceSkuId);
    if (inventory.has(sourceSkuId)) {
      throw new Error(`Mock duplicate external SKU ID: ${sourceSkuId}`);
    }
    inventory.set(sourceSkuId, validMockStock(sku.stock));
  }
  const key = mockProductKey(platform, productId);
  if (inventory.size) MOCK_PRODUCT_INVENTORY.set(key, inventory);
  else MOCK_PRODUCT_INVENTORY.delete(key);
}

function storeProductSkus(platform: PlatformType, productId: string, dto: PublishProductDto): void {
  const key = mockProductKey(platform, productId);
  const currentByKey = new Map(
    (MOCK_PRODUCT_SKUS.get(key)?.items ?? []).map((item) => [item.platformSkuKey, item]),
  );
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const skus = dto.skus.length
    ? dto.skus
    : [{ specName: '默认', price: dto.salePrice, stock: 0, attributes: {} }];
  const items = skus.map((sku, index) => {
    const platformSkuKey = validMockSkuId(sku.sourceSkuId ?? `mock-source-${index + 1}`);
    if (seenKeys.has(platformSkuKey)) {
      throw new Error(`Mock duplicate external SKU ID: ${platformSkuKey}`);
    }
    seenKeys.add(platformSkuKey);
    const current = currentByKey.get(platformSkuKey);
    const platformSkuId = current?.platformSkuId ?? allocateMockSkuId(key, platformSkuKey, seenIds);
    if (seenIds.has(platformSkuId)) throw new Error(`Mock duplicate SKU ID: ${platformSkuId}`);
    seenIds.add(platformSkuId);
    const image = sku.image?.trim();
    return {
      platformSkuId,
      platformSkuKey,
      properties: mockSkuProperties(sku.specName, sku.attributes),
      priceCents: validMockPrice(Math.round(sku.price * 100)),
      stock: validMockStock(sku.stock),
      skuStatus: current?.skuStatus ?? true,
      skuType: current?.skuType ?? 0,
      code: current?.code ?? null,
      supplierId: current?.supplierId ?? null,
      stepStock: current?.stepStock ?? 0,
      barcodes: [...(current?.barcodes ?? [])],
      skuPictureUrls: image ? [image] : [...(current?.skuPictureUrls ?? [])],
    };
  });
  MOCK_PRODUCT_SKUS.set(key, {
    categoryId: dto.categoryId,
    productType: MOCK_PRODUCT_SKUS.get(key)?.productType ?? 0,
    startSaleType: MOCK_PRODUCT_SKUS.get(key)?.startSaleType ?? 0,
    items,
  });
}

function mockSkuProperties(
  specName: string,
  attributes: Record<string, string>,
): PlatformProductSkuState['items'][number]['properties'] {
  const entries = Object.entries(attributes)
    .map(([name, value]): [string, string] => [
      validMockText(name, 'SKU property name'),
      validMockText(value, 'SKU value'),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  const effective: Array<[string, string]> = entries.length
    ? entries
    : [['规格', validMockText(specName || '默认', 'SKU value')]];
  return effective.map(([propertyName, valueName]) => ({
    propertyId: `mock-property-${hashTitle(propertyName)}`,
    propertyName,
    valueId: `mock-value-${hashTitle(`${propertyName}\u0000${valueName}`)}`,
    valueName,
    remark: null,
  }));
}

function validateMockSkuReplacement(
  productKey: string,
  currentItems: PlatformProductSkuState['items'],
  dto: ReplaceProductSkusDto,
): PlatformProductSkuState['items'] {
  if (dto.keepOffline !== true)
    throw new Error('Mock SKU replacement must keep the product offline');
  if (!Array.isArray(dto.dimensions) || dto.dimensions.length < 1 || dto.dimensions.length > 3) {
    throw new Error('Mock SKU replacement requires 1 to 3 dimensions');
  }
  if (!Array.isArray(dto.items) || dto.items.length < 1 || dto.items.length > 100) {
    throw new Error('Mock SKU replacement requires 1 to 100 SKUs');
  }

  const dimensions = new Map<
    string,
    {
      propertyId: string;
      propertyName: string;
      values: Map<string, { valueName: string; remark: string | null }>;
    }
  >();
  const nonCustomPropertyIds = new Set<string>();
  const dimensionNames = new Set<string>();
  for (const dimension of dto.dimensions) {
    const propertyId = validMockText(dimension.propertyId, 'SKU property ID');
    const propertyName = validMockText(dimension.propertyName, 'SKU property name');
    const propertyIdentity = mockSkuPropertyIdentity(propertyId, propertyName);
    if (
      dimensions.has(propertyIdentity) ||
      (propertyId !== '0' && nonCustomPropertyIds.has(propertyId)) ||
      dimensionNames.has(propertyName)
    ) {
      throw new Error('Mock duplicate SKU property');
    }
    if (!Array.isArray(dimension.values) || !dimension.values.length) {
      throw new Error('Mock SKU dimension requires at least one value');
    }
    const values = new Map<string, { valueName: string; remark: string | null }>();
    const nonCustomValueIds = new Set<string>();
    const displayNames = new Set<string>();
    for (const value of dimension.values) {
      const valueId = validMockText(value.valueId, 'SKU value ID');
      const valueName = validMockText(value.valueName, 'SKU value');
      const remark =
        value.remark === undefined ? null : validMockText(value.remark, 'SKU value remark');
      const identity = mockSkuValueIdentity(valueId, valueName, remark);
      if (values.has(identity) || (valueId !== '0' && nonCustomValueIds.has(valueId))) {
        throw new Error(`Mock duplicate SKU value ID: ${valueId}`);
      }
      const displayName = remark ?? valueName;
      if (displayNames.has(displayName))
        throw new Error(`Mock duplicate SKU value: ${displayName}`);
      values.set(identity, { valueName, remark });
      if (valueId !== '0') nonCustomValueIds.add(valueId);
      displayNames.add(displayName);
    }
    dimensions.set(propertyIdentity, { propertyId, propertyName, values });
    if (propertyId !== '0') nonCustomPropertyIds.add(propertyId);
    dimensionNames.add(propertyName);
  }

  const currentByKey = new Map(currentItems.map((item) => [item.platformSkuKey, item]));
  const currentById = new Map(currentItems.map((item) => [item.platformSkuId, item]));
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const seenCombinations = new Set<string>();
  const result = dto.items.map((item) => {
    const platformSkuKey = validMockSkuId(item.platformSkuKey);
    if (seenKeys.has(platformSkuKey)) {
      throw new Error(`Mock duplicate external SKU ID: ${platformSkuKey}`);
    }
    seenKeys.add(platformSkuKey);

    const currentByStableKey = currentByKey.get(platformSkuKey);
    let platformSkuId: string;
    if (item.platformSkuId !== undefined) {
      platformSkuId = validMockText(item.platformSkuId, 'SKU ID');
      const current = currentById.get(platformSkuId);
      if (!current || current.platformSkuKey !== platformSkuKey) {
        throw new Error('Mock existing SKU ID and key do not match');
      }
    } else {
      if (currentByStableKey) throw new Error('Mock existing SKU must preserve its SKU ID');
      platformSkuId = allocateMockSkuId(productKey, platformSkuKey, seenIds);
    }
    if (seenIds.has(platformSkuId)) throw new Error(`Mock duplicate SKU ID: ${platformSkuId}`);
    seenIds.add(platformSkuId);

    if (!Array.isArray(item.properties) || item.properties.length !== dimensions.size) {
      throw new Error('Mock SKU properties do not match the replacement dimensions');
    }
    const itemProperties = new Map(
      item.properties.map((property) => [
        mockSkuPropertyIdentity(property.propertyId, property.propertyName),
        property,
      ]),
    );
    if (itemProperties.size !== item.properties.length) {
      throw new Error('Mock SKU contains duplicate properties');
    }
    const properties = [...dimensions.values()].map((dimension) => {
      const property = itemProperties.get(
        mockSkuPropertyIdentity(dimension.propertyId, dimension.propertyName),
      );
      const value = property
        ? dimension.values.get(
            mockSkuValueIdentity(property.valueId, property.valueName, property.remark),
          )
        : undefined;
      if (
        !property ||
        property.propertyName !== dimension.propertyName ||
        !value ||
        property.valueName !== value.valueName ||
        property.remark !== value.remark
      ) {
        throw new Error('Mock SKU property does not match the replacement dimensions');
      }
      return { ...property };
    });
    const combination = JSON.stringify(
      properties.map((property) => [
        property.propertyId,
        property.propertyName,
        property.valueId,
        property.valueName,
        property.remark,
      ]),
    );
    if (seenCombinations.has(combination)) {
      throw new Error('Mock SKU replacement contains a duplicate property combination');
    }
    seenCombinations.add(combination);

    if (typeof item.skuStatus !== 'boolean' || item.skuType !== 0) {
      throw new Error('Mock SKU replacement only supports ordinary SKUs');
    }
    return {
      platformSkuId,
      platformSkuKey,
      properties,
      priceCents: validMockPrice(item.priceCents),
      stock: validMockStock(item.stock),
      skuStatus: item.skuStatus,
      skuType: item.skuType,
      code: validMockNullableText(item.code, 'SKU code'),
      supplierId: validMockNullableText(item.supplierId, 'supplier ID'),
      stepStock: validMockStock(item.stepStock),
      barcodes: validMockTextList(item.barcodes, 'SKU barcode'),
      skuPictureUrls: validMockTextList(item.skuPictureUrls, 'SKU picture URL'),
    };
  });
  return result;
}

function mockSkuValueIdentity(valueId: string, valueName: string, remark: string | null): string {
  return JSON.stringify([valueId, valueName, remark]);
}

function mockSkuPropertyIdentity(propertyId: string, propertyName: string): string {
  return JSON.stringify([propertyId, propertyName]);
}

function allocateMockSkuId(productKey: string, platformSkuKey: string, seen: Set<string>): string {
  const base = `mock-sku-${hashTitle(`${productKey}\u0000${platformSkuKey}`)}`;
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function cloneMockSkuItems(
  items: PlatformProductSkuState['items'],
): PlatformProductSkuState['items'] {
  return items.map((item) => ({
    ...item,
    properties: item.properties.map((property) => ({ ...property })),
    barcodes: [...item.barcodes],
    skuPictureUrls: [...item.skuPictureUrls],
  }));
}

function compareMockSkuItems(
  left: PlatformProductSkuState['items'][number],
  right: PlatformProductSkuState['items'][number],
): number {
  return left.platformSkuKey < right.platformSkuKey
    ? -1
    : left.platformSkuKey > right.platformSkuKey
      ? 1
      : 0;
}

function validMockText(value: string, label: string): string {
  const text = value.trim();
  if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`Mock ${label} is invalid`);
  }
  return text;
}

function validMockNullableText(value: string | null, label: string): string | null {
  return value === null ? null : validMockText(value, label);
}

function validMockTextList(value: string[], label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Mock ${label} list is invalid`);
  const result = value.map((item) => validMockText(item, label));
  if (new Set(result).size !== result.length) throw new Error(`Mock duplicate ${label}`);
  return result;
}

function mockProductKey(platform: PlatformType, productId: string): string {
  return `${platform}:${productId}`;
}

function onlineMockProductState(): PlatformProductState {
  return { state: 'online', status: 0, checkStatus: 3 };
}

function mockProductState(key: string): PlatformProductState {
  return MOCK_PRODUCT_STATES.get(key) ?? onlineMockProductState();
}

function validMockSkuId(value: string): string {
  const sourceSkuId = value.trim();
  if (!sourceSkuId) throw new Error('Mock external SKU ID is invalid');
  return sourceSkuId;
}

function validMockPrice(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Mock SKU price is invalid');
  return value;
}

function validMockStock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Mock SKU stock is invalid');
  return value;
}

function validMockTitle(platform: PlatformType, value: string): string {
  const title = value.trim();
  if (!title || /[\r\n]/.test(title)) throw new Error('Mock product title is invalid');
  if (platform === 'douyin') {
    const units = [...title].reduce(
      (total, character) => total + (/^[\x00-\x7f]$/.test(character) ? 1 : 2),
      0,
    );
    if (units < 16 || units > 60) throw new Error('Mock product title is invalid');
    return title;
  }
  const maxLength = ['pdd', 'kuaishou', 'wechat_shop'].includes(platform) ? 30 : 60;
  if ([...title].length > maxLength) throw new Error('Mock product title is invalid');
  return title;
}

export function createMockAdapter(platform: PlatformType): MockPlatformAdapter {
  return new MockPlatformAdapter(platform);
}
