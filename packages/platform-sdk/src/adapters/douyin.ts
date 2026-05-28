import type { PlatformType, TokenSet } from '@supplier/shared-types';
import { BasePlatformAdapter } from '../adapter';
import type {
  CategoryAttr,
  CategoryNode,
  OrderQuery,
  PlatformOrder,
  PublishProductDto,
  PublishResult,
  ShipDto,
  UpdateProductDto,
} from '../types';

/**
 * 抖音小店适配器
 * TODO: 接入 op.jinritemai.com 官方 OpenAPI
 */
export class DouyinAdapter extends BasePlatformAdapter {
  readonly platform: PlatformType = 'douyin';

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      app_id: this.config.appKey,
      response_type: 'code',
      state,
      redirect_uri: this.config.redirectUri,
      service_id: 'product',
    });
    return `https://fuwu.jinritemai.com/authorize?${params.toString()}`;
  }

  async exchangeToken(_code: string): Promise<TokenSet> {
    throw new Error('Not implemented: douyin.exchangeToken');
  }

  async refreshToken(_refreshToken: string): Promise<TokenSet> {
    throw new Error('Not implemented: douyin.refreshToken');
  }

  async publishProduct(_token: string, _dto: PublishProductDto): Promise<PublishResult> {
    throw new Error('Not implemented: douyin.publishProduct');
  }

  async updateProduct(_token: string, _dto: UpdateProductDto): Promise<void> {
    throw new Error('Not implemented: douyin.updateProduct');
  }

  async offlineProduct(_token: string, _productId: string): Promise<void> {
    throw new Error('Not implemented: douyin.offlineProduct');
  }

  async getCategoryTree(_token: string): Promise<CategoryNode[]> {
    throw new Error('Not implemented: douyin.getCategoryTree');
  }

  async getCategoryAttributes(_token: string, _categoryId: string): Promise<CategoryAttr[]> {
    throw new Error('Not implemented: douyin.getCategoryAttributes');
  }

  async listOrders(_token: string, _query: OrderQuery): Promise<PlatformOrder[]> {
    throw new Error('Not implemented: douyin.listOrders');
  }

  async shipOrder(_token: string, _dto: ShipDto): Promise<void> {
    throw new Error('Not implemented: douyin.shipOrder');
  }

  protected sign(_params: Record<string, unknown>): string {
    // TODO: HMAC-SHA256 签名
    return '';
  }
}
