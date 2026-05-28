import type { PlatformType } from './platform';

export type PublishTaskStatus =
  | 'pending'
  | 'optimizing'
  | 'publishing'
  | 'partial'
  | 'success'
  | 'failed';

export interface PublishTask {
  id: string;
  userId: string;
  sourceProductId: string;
  targetShopIds: string[];
  status: PublishTaskStatus;
  aiOptimized?: AiOptimizedContent;
  pricingStrategy?: PricingStrategy;
  errorMsg?: string;
  createdAt: Date;
  finishedAt?: Date;
}

export interface AiOptimizedContent {
  titles: Record<PlatformType, string[]>;
  detailHtml: string;
  mainImages: string[];
  categoryMapping: Record<PlatformType, string>;
  complianceFlags: string[];
}

export type PricingMode = 'fixed_markup' | 'competitor_anchor' | 'profit_target';

export interface PricingStrategy {
  mode: PricingMode;
  markupRatio?: number;
  targetMargin?: number;
  competitorPriceRange?: [number, number];
  finalPrice: number;
}

export interface PublishedProduct {
  id: string;
  taskId: string;
  shopId: string;
  sourceProductId: string;
  platform: PlatformType;
  platformProductId: string;
  title: string;
  salePrice: number;
  costPrice: number;
  status: 'online' | 'offline' | 'draft' | 'rejected';
  publishedAt: Date;
}
