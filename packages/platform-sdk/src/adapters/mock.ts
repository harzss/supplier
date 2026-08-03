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
  PlatformProductPriceState,
  PlatformProductState,
  PublishProductDto,
  PublishResult,
  ShipDto,
  ShipPackagesDto,
  SyncInventoryDto,
  UpdateProductDto,
  UpdateProductPriceDto,
} from '../types';

const DEFAULT_CONFIG: AdapterConfig = {
  appKey: 'mock',
  appSecret: 'mock',
  redirectUri: 'https://mock.local/callback',
  sandbox: true,
};

const MOCK_PRODUCT_PRICES = new Map<string, Map<string, number>>();

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
    return { platformProductId: id, url: `https://mock.${this.platform}.shop/item/${id}` };
  }

  async updateProduct(_token: string, dto: UpdateProductDto): Promise<void> {
    storeProductPrices(this.platform, dto.platformProductId, dto.skus);
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
    const prices = MOCK_PRODUCT_PRICES.get(mockProductKey(this.platform, productId));
    if (!prices?.size) throw new Error('Mock product prices are unavailable');
    return {
      state: 'online',
      status: 0,
      checkStatus: 3,
      items: [...prices]
        .map(([sourceSkuId, priceCents]) => ({ sourceSkuId, priceCents }))
        .sort((left, right) =>
          left.sourceSkuId < right.sourceSkuId ? -1 : left.sourceSkuId > right.sourceSkuId ? 1 : 0,
        ),
    };
  }

  async getProductState(_token: string, _productId: string): Promise<PlatformProductState> {
    return { state: 'online', status: 0, checkStatus: 3 };
  }

  async syncInventory(_token: string, _dto: SyncInventoryDto): Promise<void> {
    /* 模拟：无操作 */
  }

  async offlineProduct(_token: string, _productId: string): Promise<void> {
    /* 模拟：无操作 */
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

function mockProductKey(platform: PlatformType, productId: string): string {
  return `${platform}:${productId}`;
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

export function createMockAdapter(platform: PlatformType): MockPlatformAdapter {
  return new MockPlatformAdapter(platform);
}
