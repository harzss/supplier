import type { PlatformType, TokenSet } from '@supplier/shared-types';
import type {
  AdapterConfig,
  CategoryAttr,
  CategoryNode,
  OrderQuery,
  PlatformOrder,
  PublishProductDto,
  PublishResult,
  ShipDto,
  UpdateProductDto,
} from './types';

export interface PlatformAdapter {
  readonly platform: PlatformType;

  // ---- 授权 ----
  buildAuthUrl(state: string): string;
  exchangeToken(code: string): Promise<TokenSet>;
  refreshToken(refreshToken: string): Promise<TokenSet>;

  // ---- 商品 ----
  publishProduct(token: string, dto: PublishProductDto): Promise<PublishResult>;
  updateProduct(token: string, dto: UpdateProductDto): Promise<void>;
  offlineProduct(token: string, productId: string): Promise<void>;

  // ---- 类目 ----
  getCategoryTree(token: string): Promise<CategoryNode[]>;
  getCategoryAttributes(token: string, categoryId: string): Promise<CategoryAttr[]>;

  // ---- 订单 ----
  listOrders(token: string, query: OrderQuery): Promise<PlatformOrder[]>;
  shipOrder(token: string, dto: ShipDto): Promise<void>;
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformType;

  constructor(protected readonly config: AdapterConfig) {}

  abstract buildAuthUrl(state: string): string;
  abstract exchangeToken(code: string): Promise<TokenSet>;
  abstract refreshToken(refreshToken: string): Promise<TokenSet>;
  abstract publishProduct(token: string, dto: PublishProductDto): Promise<PublishResult>;
  abstract updateProduct(token: string, dto: UpdateProductDto): Promise<void>;
  abstract offlineProduct(token: string, productId: string): Promise<void>;
  abstract getCategoryTree(token: string): Promise<CategoryNode[]>;
  abstract getCategoryAttributes(token: string, categoryId: string): Promise<CategoryAttr[]>;
  abstract listOrders(token: string, query: OrderQuery): Promise<PlatformOrder[]>;
  abstract shipOrder(token: string, dto: ShipDto): Promise<void>;

  /**
   * 通用签名占位 — 各平台覆盖实现
   */
  protected abstract sign(params: Record<string, unknown>): string;
}
