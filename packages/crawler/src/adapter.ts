import type { CrawledProduct } from './types';

/** 1688 数据源适配器（OpenAPI / Mock / 离线 JSON 等共用） */
export interface SourceAdapter {
  readonly name: string;
  /** 拉取单个商品；找不到时返回 null，不抛错 */
  fetchProduct(productId1688: string): Promise<CrawledProduct | null>;
  /** 按类目拉取候选商品 ID 列表；可选实现 */
  searchByCategory?(categoryL1: string, limit: number): Promise<string[]>;
}

/** Adapter 抛错时使用的统一错误类型 */
export class CrawlerError extends Error {
  constructor(
    message: string,
    public readonly code: 'rate_limited' | 'not_found' | 'auth' | 'network' | 'parse' | 'unknown',
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'CrawlerError';
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'network';
  }
}
