export type AnalyticsRangeDays = 7 | 30 | 90;

export interface AnalyticsOverview {
  range: {
    days: AnalyticsRangeDays;
    startAt: string;
    endAt: string;
    timezone: 'Asia/Shanghai';
  };
  kpis: {
    effectiveGmv: number;
    refundedAmount: number;
    validOrders: number;
    unreconciledRefundOrders: number;
    unreconciledGrossAmount: number;
    averageOrderValue: number;
    estimatedGrossProfit: number | null;
    estimatedGrossMargin: number | null;
    cost: AnalyticsCostSummary;
  };
  daily: AnalyticsDailyPoint[];
  shops: AnalyticsShopBreakdown[];
  products: AnalyticsProductBreakdown[];
  productPerformance: AnalyticsProductPerformance;
  statuses: AnalyticsStatusBreakdown[];
  methodology: {
    gmv: string;
    cost: string;
    profit: string;
    exclusions: string[];
  };
}

export interface AnalyticsCostSummary {
  total: number | null;
  confirmed: number;
  estimated: number;
  uncostedOrders: number;
  coverageRate: number;
}

export interface AnalyticsDailyPoint {
  date: string;
  effectiveGmv: number;
  refundedAmount: number;
  validOrders: number;
  estimatedGrossProfit: number | null;
}

export interface AnalyticsShopBreakdown {
  shopId: string;
  shopName: string;
  platform: string;
  effectiveGmv: number;
  refundedAmount: number;
  validOrders: number;
  estimatedGrossProfit: number | null;
  costCoverageRate: number;
}

export interface AnalyticsProductBreakdown {
  publishedProductId: string | null;
  title: string;
  effectiveGmv: number;
  validOrders: number;
  quantity: number;
  estimatedGrossProfit: number | null;
}

export interface AnalyticsProductPerformance {
  summary: {
    onlineProducts: number;
    eligibleProducts: number;
    sellingProducts: number;
    slowProducts: number;
    activityRate: number;
    graceDays: number;
  };
  hot: AnalyticsProductPerformanceItem[];
  slow: AnalyticsProductPerformanceItem[];
  methodology: string;
}

export interface AnalyticsProductPerformanceItem {
  publishedProductId: string;
  title: string;
  shopId: string;
  shopName: string;
  platform: string;
  publishedAt: string;
  daysOnline: number;
  observedDays: number;
  validOrders: number;
  quantity: number;
  effectiveGmv: number;
  estimatedGrossProfit: number | null;
  dailyOrderRate: number;
  lastPaidAt: string | null;
  daysSinceLastSale: number | null;
}

export interface AnalyticsStatusBreakdown {
  status: 'paid' | 'purchasing' | 'shipped' | 'received' | 'refunded' | 'closed';
  count: number;
  amount: number;
}
