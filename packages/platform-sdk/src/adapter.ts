import type { PlatformType, TokenSet } from '@supplier/shared-types';
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
  PlatformExecutionGuard,
  PublishProductDto,
  PublishResult,
  ReplaceProductSkusDto,
  ReplaceShipPackagesDto,
  ShipDto,
  ShipPackagesDto,
  SyncInventoryDto,
  UpdateProductDto,
  UpdateProductPriceDto,
  UpdateProductTitleDto,
} from './types';

export interface PlatformAdapter {
  readonly platform: PlatformType;

  // ---- 授权 ----
  buildAuthUrl(state: string): string;
  exchangeToken(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;

  // ---- 商品 ----
  publishProduct(token: string, dto: PublishProductDto): Promise<PublishResult>;
  findProductByExternalId?(token: string, externalProductId: string): Promise<PublishResult | null>;
  updateProduct(token: string, dto: UpdateProductDto): Promise<void>;
  updateProductTitle?(token: string, dto: UpdateProductTitleDto): Promise<void>;
  updateProductPrice?(token: string, dto: UpdateProductPriceDto): Promise<void>;
  getProductTitle?(token: string, productId: string): Promise<PlatformProductTitleState>;
  getProductPrices?(token: string, productId: string): Promise<PlatformProductPriceState>;
  getProductInventory?(token: string, productId: string): Promise<PlatformProductInventoryState>;
  getProductSkuState?(token: string, productId: string): Promise<PlatformProductSkuState>;
  getProductSkuRules?(
    token: string,
    query: PlatformProductSkuRulesQuery,
  ): Promise<PlatformProductSkuRules>;
  replaceProductSkus?(token: string, dto: ReplaceProductSkusDto): Promise<void>;
  getProductState?(token: string, productId: string): Promise<PlatformProductState>;
  onlineProduct?(token: string, productId: string): Promise<void>;
  syncInventory(token: string, dto: SyncInventoryDto): Promise<void>;
  offlineProduct(token: string, productId: string): Promise<void>;

  // ---- 类目 ----
  getCategoryTree(token: string): Promise<CategoryNode[]>;
  getCategoryAttributes(token: string, categoryId: string): Promise<CategoryAttr[]>;
  getCategoryQualifications?(token: string, categoryId: string): Promise<CategoryQualification[]>;
  recommendCategories?(
    token: string,
    input: CategoryRecommendationInput,
  ): Promise<CategoryRecommendationResult>;

  // ---- 订单 ----
  getOrder?(token: string, platformOrderId: string): Promise<PlatformOrder>;
  listOrders(token: string, query: OrderQuery): Promise<PlatformOrder[]>;
  shipOrder(token: string, dto: ShipDto): Promise<void>;
  shipPackages(token: string, dto: ShipPackagesDto): Promise<void>;
  replaceShipPackages?(
    token: string,
    dto: ReplaceShipPackagesDto,
    guard?: PlatformExecutionGuard,
  ): Promise<void>;
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformType;

  constructor(protected readonly config: AdapterConfig) {}

  abstract buildAuthUrl(state: string): string;
  abstract exchangeToken(code: string): Promise<TokenSet>;
  abstract refreshToken(refreshToken: string): Promise<TokenSet>;
  abstract publishProduct(token: string, dto: PublishProductDto): Promise<PublishResult>;
  abstract updateProduct(token: string, dto: UpdateProductDto): Promise<void>;
  abstract syncInventory(token: string, dto: SyncInventoryDto): Promise<void>;
  abstract offlineProduct(token: string, productId: string): Promise<void>;
  abstract getCategoryTree(token: string): Promise<CategoryNode[]>;
  abstract getCategoryAttributes(token: string, categoryId: string): Promise<CategoryAttr[]>;
  abstract listOrders(token: string, query: OrderQuery): Promise<PlatformOrder[]>;
  abstract shipOrder(token: string, dto: ShipDto): Promise<void>;
  abstract shipPackages(token: string, dto: ShipPackagesDto): Promise<void>;

  /**
   * 通用签名占位 — 各平台覆盖实现
   */
  protected abstract sign(params: Record<string, unknown>): string;
}
