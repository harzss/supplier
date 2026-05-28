export interface SourceProduct {
  id: string;
  productId1688: string;
  supplierId?: string;
  title: string;
  price: number;
  priceMin?: number;
  priceMax?: number;
  mainImage: string;
  detailImages: string[];
  categoryPath: string;
  categoryL1: string;
  categoryL2?: string;
  skuList: SourceSku[];
  attributes: Record<string, string>;
  monthlySold: number;
  isOnePieceDrop: boolean;
  syncedAt: Date;
}

export interface SourceSku {
  skuId: string;
  specName: string;
  price: number;
  stock: number;
  attributes: Record<string, string>;
  image?: string;
}

export interface ProductScore {
  productId: string;
  demandScore: number;
  competitionScore: number;
  profitScore: number;
  complianceScore: number;
  trendScore: number;
  overallScore: number;
  reason: string[];
  scoredAt: Date;
}

export interface ScoringFeatures {
  douyinHeat7d?: number;
  douyinHeat30d?: number;
  xhsHeat30d?: number;
  taobaoSameStyleCount?: number;
  taobaoMedianPrice?: number;
  estimatedShipping?: number;
  categoryRiskLevel?: 'low' | 'medium' | 'high';
  sensitiveWordsHit?: number;
}
