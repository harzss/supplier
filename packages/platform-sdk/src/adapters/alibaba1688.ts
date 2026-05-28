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
 * 1688 适配器 — 主要作为采购方角色（货源 + 代发）
 * TODO: 接入 open.1688.com 官方 OpenAPI
 */
export class Alibaba1688Adapter extends BasePlatformAdapter {
  readonly platform: PlatformType = 'alibaba_1688';

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.appKey,
      redirect_uri: this.config.redirectUri,
      state,
      site: 'china',
      _aop_signature: '',
    });
    return `https://auth.1688.com/oauth/authorize?${params.toString()}`;
  }

  async exchangeToken(_code: string): Promise<TokenSet> {
    throw new Error('Not implemented: alibaba1688.exchangeToken');
  }

  async refreshToken(_refreshToken: string): Promise<TokenSet> {
    throw new Error('Not implemented: alibaba1688.refreshToken');
  }

  async publishProduct(_token: string, _dto: PublishProductDto): Promise<PublishResult> {
    throw new Error('1688 不作为销售方铺货平台，这里仅用于代发下单');
  }

  async updateProduct(_token: string, _dto: UpdateProductDto): Promise<void> {
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

  protected sign(_params: Record<string, unknown>): string {
    // TODO: 实现 1688 _aop_signature HMAC-SHA1 签名
    return '';
  }
}
