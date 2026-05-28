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
 * 淘宝 / 天猫适配器
 * TODO: 接入 open.taobao.com 官方 TOP API
 */
export class TaobaoAdapter extends BasePlatformAdapter {
  readonly platform: PlatformType = 'taobao';

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.appKey,
      redirect_uri: this.config.redirectUri,
      state,
      view: 'web',
    });
    return `https://oauth.taobao.com/authorize?${params.toString()}`;
  }

  async exchangeToken(_code: string): Promise<TokenSet> {
    throw new Error('Not implemented: taobao.exchangeToken');
  }

  async refreshToken(_refreshToken: string): Promise<TokenSet> {
    throw new Error('Not implemented: taobao.refreshToken');
  }

  async publishProduct(_token: string, _dto: PublishProductDto): Promise<PublishResult> {
    throw new Error('Not implemented: taobao.publishProduct');
  }

  async updateProduct(_token: string, _dto: UpdateProductDto): Promise<void> {
    throw new Error('Not implemented: taobao.updateProduct');
  }

  async offlineProduct(_token: string, _productId: string): Promise<void> {
    throw new Error('Not implemented: taobao.offlineProduct');
  }

  async getCategoryTree(_token: string): Promise<CategoryNode[]> {
    throw new Error('Not implemented: taobao.getCategoryTree');
  }

  async getCategoryAttributes(_token: string, _categoryId: string): Promise<CategoryAttr[]> {
    throw new Error('Not implemented: taobao.getCategoryAttributes');
  }

  async listOrders(_token: string, _query: OrderQuery): Promise<PlatformOrder[]> {
    throw new Error('Not implemented: taobao.listOrders');
  }

  async shipOrder(_token: string, _dto: ShipDto): Promise<void> {
    throw new Error('Not implemented: taobao.shipOrder');
  }

  protected sign(_params: Record<string, unknown>): string {
    // TODO: TOP MD5 签名
    return '';
  }
}
