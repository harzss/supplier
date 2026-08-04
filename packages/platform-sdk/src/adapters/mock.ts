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
  PlatformProductState,
  PlatformProductTitleState,
  PublishProductDto,
  PublishResult,
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
    MOCK_PRODUCT_TITLES.set(mockProductKey(this.platform, id), dto.title);
    MOCK_PRODUCT_STATES.set(mockProductKey(this.platform, id), onlineMockProductState());
    return { platformProductId: id, url: `https://mock.${this.platform}.shop/item/${id}` };
  }

  async updateProduct(_token: string, dto: UpdateProductDto): Promise<void> {
    storeProductPrices(this.platform, dto.platformProductId, dto.skus);
    storeProductInventory(this.platform, dto.platformProductId, dto.skus);
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
    const prices = MOCK_PRODUCT_PRICES.get(key) ?? new Map<string, number>();
    prices.set(sourceSkuId, priceCents);
    MOCK_PRODUCT_PRICES.set(key, prices);
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

  async syncInventory(_token: string, dto: SyncInventoryDto): Promise<void> {
    const key = mockProductKey(this.platform, dto.platformProductId);
    const inventory = new Map(MOCK_PRODUCT_INVENTORY.get(key));
    const seen = new Set<string>();
    for (const item of dto.items) {
      const sourceSkuId = validMockSkuId(item.sourceSkuId);
      if (seen.has(sourceSkuId)) {
        throw new Error(`Mock duplicate external SKU ID: ${sourceSkuId}`);
      }
      seen.add(sourceSkuId);
      inventory.set(sourceSkuId, validMockStock(item.stock));
    }
    if (inventory.size) MOCK_PRODUCT_INVENTORY.set(key, inventory);
  }

  async offlineProduct(_token: string, productId: string): Promise<void> {
    MOCK_PRODUCT_STATES.set(mockProductKey(this.platform, productId), {
      state: 'offline',
      status: 1,
      checkStatus: 3,
    });
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
  if (prices.size) MOCK_PRODUCT_PRICES.set(mockProductKey(platform, productId), prices);
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
  if (inventory.size) MOCK_PRODUCT_INVENTORY.set(mockProductKey(platform, productId), inventory);
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
