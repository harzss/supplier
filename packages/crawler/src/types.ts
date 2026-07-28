/**
 * 采集到的标准化商品数据。
 * 各 Adapter（OpenAPI / Mock / 离线 JSON）必须统一产出此结构。
 */
export interface CrawledProduct {
  productId1688: string;
  supplierId?: string;
  title: string;
  /** 进货价（元）— 如有阶梯，取最低 */
  price: number;
  priceMin?: number;
  priceMax?: number;
  mainImage?: string;
  detailImages?: string[];
  categoryPath?: string;
  categoryL1?: string;
  categoryL2?: string;
  skuList?: CrawledSku[];
  attributes?: Record<string, string>;
  monthlySold?: number;
  isCrossBorder?: boolean;
  isOnePieceDrop?: boolean;
  /** 外部信号（抖音/淘宝/小红书等），可选；用于打分输入 */
  signals?: ExternalSignals;
}

export interface CrawledSku {
  skuId: string;
  specName: string;
  price: number;
  stock: number;
  attributes?: Record<string, string>;
  image?: string;
}

export interface ExternalSignals {
  douyinHeat7d?: number;
  douyinHeat30d?: number;
  xhsNoteCount30d?: number;
  taobaoSameStyleCount?: number;
  douyinSameStyleCount?: number;
  competitorMedianPrice?: number;
  estimatedShipping?: number;
  categoryRiskLevel?: 'low' | 'medium' | 'high';
  sensitiveWordsHit?: number;
  growthRate30d?: number;
}

export interface CrawlError {
  productId1688: string;
  reason: string;
  retryCount: number;
  isFatal: boolean;
}

export interface CrawlReport {
  total: number;
  succeeded: number;
  failed: number;
  durations: { p50: number; p95: number; max: number };
  errors: CrawlError[];
}
