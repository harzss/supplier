import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import type {
  AnalyticsCostSummary,
  AnalyticsDailyPoint,
  AnalyticsOverview,
  AnalyticsProductBreakdown,
  AnalyticsProductPerformance,
  AnalyticsProductPerformanceItem,
  AnalyticsRangeDays,
  AnalyticsShopBreakdown,
  AnalyticsStatusBreakdown,
} from '@supplier/shared-types';
import { PrismaService } from '../../common/prisma.module';
import { estimatePurchaseCost, orderQuantity } from '../order/order-cost';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOW_GRACE_DAYS = 7;
const VALID_STATUSES = new Set(['paid', 'purchasing', 'shipped', 'received']);
const STATUS_ORDER: AnalyticsStatusBreakdown['status'][] = [
  'paid',
  'purchasing',
  'shipped',
  'received',
  'refunded',
  'closed',
];

const ORDER_SELECT = {
  id: true,
  amount: true,
  status: true,
  afterSaleStatus: true,
  partialRefundFingerprint: true,
  refundAmount: true,
  refundAmountFingerprint: true,
  paidAt: true,
  skuInfo: true,
  items: { select: { refundStatusRaw: true } },
  publishedProduct: { select: { id: true, title: true, costPrice: true } },
  purchaseOrders: {
    select: {
      purchaseCost: true,
      priorIncurredCost: true,
      reconciledCost: true,
      exceptionStatus: true,
      orderId1688: true,
      status: true,
    },
  },
} satisfies Prisma.OrderSelect;

const PUBLISHED_PRODUCT_SELECT = {
  id: true,
  title: true,
  publishedAt: true,
  shop: { select: { id: true, shopName: true, platform: true } },
  orders: {
    where: { status: { in: ['paid', 'purchasing', 'shipped', 'received'] } },
    orderBy: { paidAt: 'desc' },
    take: 1,
    select: { paidAt: true },
  },
} satisfies Prisma.PublishedProductSelect;

type AnalyticsShop = { id: bigint; shopName: string | null; platform: string };
type AnalyticsOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }> & {
  shop: AnalyticsShop;
};
type AnalyticsPublishedProduct = Prisma.PublishedProductGetPayload<{
  select: typeof PUBLISHED_PRODUCT_SELECT;
}> & { shop: AnalyticsShop };

interface AggregateBucket {
  effectiveGmv: number;
  refundedAmount: number;
  validOrders: number;
  confirmedCost: number;
  estimatedCost: number;
  uncostedOrders: number;
  quantity: number;
  unreconciledRefundOrders: number;
  unreconciledGrossAmount: number;
  costRelevantOrders: number;
}

@Injectable()
export class AnalyticsService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async overview(
    userId: bigint,
    days: AnalyticsRangeDays,
    now = new Date(),
  ): Promise<AnalyticsOverview> {
    const range = chinaDateRange(days, now);
    const shops = await this.prisma.shop.findMany({
      relationLoadStrategy: 'join',
      where: { userId, ...runtimeShopWhere(this.demoMode) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        shopName: true,
        platform: true,
        orders: {
          where: { paidAt: { gte: range.startAt, lte: range.endAt } },
          orderBy: { paidAt: 'asc' },
          select: ORDER_SELECT,
        },
        publishedProducts: {
          where: { status: 'online', publishedAt: { lte: range.endAt } },
          orderBy: { publishedAt: 'asc' },
          select: PUBLISHED_PRODUCT_SELECT,
        },
      },
    });
    const orders: AnalyticsOrder[] = shops.flatMap((shop) =>
      shop.orders.map((order) => ({
        ...order,
        shop: { id: shop.id, shopName: shop.shopName, platform: shop.platform },
      })),
    );
    const publishedProducts: AnalyticsPublishedProduct[] = shops.flatMap((shop) =>
      shop.publishedProducts.map((product) => ({
        ...product,
        shop: { id: shop.id, shopName: shop.shopName, platform: shop.platform },
      })),
    );

    const overall = emptyBucket();
    const daily = new Map<string, AggregateBucket>();
    const shopBuckets = new Map<
      string,
      { shopName: string; platform: string; bucket: AggregateBucket }
    >();
    const productBuckets = new Map<
      string,
      { publishedProductId: string | null; title: string; bucket: AggregateBucket }
    >();
    const statusBuckets = new Map<
      AnalyticsStatusBreakdown['status'],
      { count: number; amount: number }
    >(STATUS_ORDER.map((status) => [status, { count: 0, amount: 0 }]));

    for (const date of chinaDateKeys(days, range.endAt)) daily.set(date, emptyBucket());
    for (const shop of shops) {
      shopBuckets.set(shop.id.toString(), {
        shopName: shop.shopName ?? `店铺 ${shop.id.toString()}`,
        platform: shop.platform,
        bucket: emptyBucket(),
      });
    }

    for (const order of orders) {
      const dateKey = chinaDateKey(order.paidAt ?? range.endAt);
      const dailyBucket = daily.get(dateKey);
      const shopId = order.shop.id.toString();
      const shopEntry = shopBuckets.get(shopId) ?? {
        shopName: order.shop.shopName ?? `店铺 ${shopId}`,
        platform: order.shop.platform,
        bucket: emptyBucket(),
      };
      shopBuckets.set(shopId, shopEntry);

      addOrder(overall, order);
      if (dailyBucket) addOrder(dailyBucket, order);
      addOrder(shopEntry.bucket, order);

      const status = statusBuckets.get(order.status);
      if (status) {
        status.count++;
        status.amount += Number(order.amount);
      }

      if (VALID_STATUSES.has(order.status)) {
        const productId = order.publishedProduct?.id.toString() ?? 'unlinked';
        const productEntry = productBuckets.get(productId) ?? {
          publishedProductId: order.publishedProduct?.id.toString() ?? null,
          title: order.publishedProduct?.title ?? '未关联铺货商品',
          bucket: emptyBucket(),
        };
        addOrder(productEntry.bucket, order);
        productBuckets.set(productId, productEntry);
      }
    }

    const cost = costSummary(overall);
    const estimatedGrossProfit = profit(overall);
    return {
      range: {
        days,
        startAt: range.startAt.toISOString(),
        endAt: range.endAt.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      kpis: {
        effectiveGmv: money(overall.effectiveGmv),
        refundedAmount: money(overall.refundedAmount),
        validOrders: overall.validOrders,
        unreconciledRefundOrders: overall.unreconciledRefundOrders,
        unreconciledGrossAmount: money(overall.unreconciledGrossAmount),
        averageOrderValue: money(
          overall.validOrders ? overall.effectiveGmv / overall.validOrders : 0,
        ),
        estimatedGrossProfit,
        estimatedGrossMargin:
          estimatedGrossProfit === null || overall.effectiveGmv === 0
            ? null
            : ratio(estimatedGrossProfit / overall.effectiveGmv),
        cost,
      },
      daily: [...daily.entries()].map(
        ([date, bucket]): AnalyticsDailyPoint => ({
          date,
          effectiveGmv: money(bucket.effectiveGmv),
          refundedAmount: money(bucket.refundedAmount),
          validOrders: bucket.validOrders,
          estimatedGrossProfit: profit(bucket),
        }),
      ),
      shops: [...shopBuckets.entries()]
        .map(
          ([shopId, entry]): AnalyticsShopBreakdown => ({
            shopId,
            shopName: entry.shopName,
            platform: entry.platform,
            effectiveGmv: money(entry.bucket.effectiveGmv),
            refundedAmount: money(entry.bucket.refundedAmount),
            validOrders: entry.bucket.validOrders,
            estimatedGrossProfit: profit(entry.bucket),
            costCoverageRate: coverageRate(entry.bucket),
          }),
        )
        .sort((a, b) => b.effectiveGmv - a.effectiveGmv),
      products: [...productBuckets.values()]
        .map(
          (entry): AnalyticsProductBreakdown => ({
            publishedProductId: entry.publishedProductId,
            title: entry.title,
            effectiveGmv: money(entry.bucket.effectiveGmv),
            validOrders: entry.bucket.validOrders,
            quantity: entry.bucket.quantity,
            estimatedGrossProfit: profit(entry.bucket),
          }),
        )
        .sort((a, b) => b.effectiveGmv - a.effectiveGmv)
        .slice(0, 10),
      productPerformance: buildProductPerformance(
        publishedProducts,
        productBuckets,
        days,
        range.endAt,
      ),
      statuses: STATUS_ORDER.map((status) => ({
        status,
        count: statusBuckets.get(status)?.count ?? 0,
        amount: money(statusBuckets.get(status)?.amount ?? 0),
      })),
      methodology: {
        gmv: '有效 GMV 统计 paid、purchasing、shipped、received 状态订单并扣除已核对退款；平台未提供实际退款金额时，待核对订单暂不计入 GMV、毛利与排行。',
        cost: '正常采购使用 1688 采购金额；退款/关闭后的远端采购使用人工核销的最终实际成本，未触达 1688 的自动停止采购按 0 计算。历史订单缺少采购记录时按商品成本估算。',
        profit:
          '预计毛利 = 有效 GMV - 最终采购成本；存在未核销采购异常或无法估算成本的订单时不展示汇总毛利。',
        exclusions: ['平台佣金', '广告费', '运费差额', '税费及售后额外成本'],
      },
    };
  }
}

function buildProductPerformance(
  products: AnalyticsPublishedProduct[],
  productBuckets: Map<
    string,
    { publishedProductId: string | null; title: string; bucket: AggregateBucket }
  >,
  rangeDays: AnalyticsRangeDays,
  endAt: Date,
): AnalyticsProductPerformance {
  const items = products.map((product): AnalyticsProductPerformanceItem => {
    const bucket = productBuckets.get(product.id.toString())?.bucket ?? emptyBucket();
    const daysOnline = elapsedDays(product.publishedAt, endAt);
    const observedDays = Math.min(rangeDays, daysOnline);
    const lastPaidAt = product.orders[0]?.paidAt ?? null;
    return {
      publishedProductId: product.id.toString(),
      title: product.title,
      shopId: product.shop.id.toString(),
      shopName: product.shop.shopName ?? `店铺 ${product.shop.id.toString()}`,
      platform: product.shop.platform,
      publishedAt: product.publishedAt.toISOString(),
      daysOnline,
      observedDays,
      validOrders: bucket.validOrders,
      quantity: bucket.quantity,
      effectiveGmv: money(bucket.effectiveGmv),
      estimatedGrossProfit: profit(bucket),
      dailyOrderRate: ratio(bucket.validOrders / observedDays),
      lastPaidAt: lastPaidAt?.toISOString() ?? null,
      daysSinceLastSale: lastPaidAt ? Math.max(0, elapsedDays(lastPaidAt, endAt) - 1) : null,
    };
  });
  const eligibleProducts = items.filter((item) => item.daysOnline >= SLOW_GRACE_DAYS).length;
  const sellingProducts = items.filter((item) => item.validOrders > 0).length;
  const slow = items
    .filter((item) => item.daysOnline >= SLOW_GRACE_DAYS && item.validOrders === 0)
    .sort((a, b) => {
      const aInactive = a.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
      const bInactive = b.daysSinceLastSale ?? Number.POSITIVE_INFINITY;
      return bInactive - aInactive || b.daysOnline - a.daysOnline;
    });
  const hot = items
    .filter((item) => item.validOrders > 0)
    .sort(
      (a, b) =>
        b.dailyOrderRate - a.dailyOrderRate ||
        b.effectiveGmv - a.effectiveGmv ||
        b.quantity - a.quantity,
    );

  return {
    summary: {
      onlineProducts: items.length,
      eligibleProducts,
      sellingProducts,
      slowProducts: slow.length,
      activityRate: items.length ? ratio(sellingProducts / items.length) : 0,
      graceDays: SLOW_GRACE_DAYS,
    },
    hot: hot.slice(0, 10),
    slow: slow.slice(0, 10),
    methodology:
      '热销按观察期内日均有效订单排序，GMV 为次级排序；待核对实际退款金额的订单暂不进入动销排行。滞销风险仅标记上架满 7 天且区间内无有效成交的在线商品。库存风险由独立库存联动处理；当前未接入曝光与点击数据，因此本榜单不代表转化率。',
  };
}

function addOrder(bucket: AggregateBucket, order: AnalyticsOrder): void {
  const amount = Number(order.amount);
  if (order.status === 'refunded') {
    bucket.refundedAmount += amount;
    addTerminalPurchaseCost(bucket, order);
    return;
  }
  if (order.status === 'closed') {
    addTerminalPurchaseCost(bucket, order);
    return;
  }
  if (!VALID_STATUSES.has(order.status)) return;

  const hasSuccessfulRefund =
    order.afterSaleStatus === 'partial_refund' ||
    order.items.some((item) => item.refundStatusRaw === 3);
  const refundAmount = order.refundAmount === null ? null : Number(order.refundAmount);
  const refundAmountConfirmed =
    hasSuccessfulRefund &&
    refundAmount !== null &&
    Number.isFinite(refundAmount) &&
    refundAmount > 0 &&
    refundAmount < amount &&
    order.refundAmountFingerprint !== null &&
    order.refundAmountFingerprint === order.partialRefundFingerprint;
  if (hasSuccessfulRefund && !refundAmountConfirmed) {
    bucket.unreconciledRefundOrders++;
    bucket.unreconciledGrossAmount += amount;
    return;
  }

  const appliedRefundAmount = refundAmountConfirmed ? (refundAmount ?? 0) : 0;
  bucket.effectiveGmv += amount - appliedRefundAmount;
  bucket.refundedAmount += appliedRefundAmount;
  bucket.validOrders++;
  bucket.quantity += orderQuantity(order.skuInfo);
  bucket.costRelevantOrders++;

  if (order.purchaseOrders.length > 0) return addStoredPurchaseCost(bucket, order);
  const estimated = estimatePurchaseCost(
    order.publishedProduct?.costPrice === null || order.publishedProduct?.costPrice === undefined
      ? null
      : Number(order.publishedProduct.costPrice),
    order.skuInfo,
  );
  if (estimated === null) bucket.uncostedOrders++;
  else bucket.estimatedCost += estimated;
}

function emptyBucket(): AggregateBucket {
  return {
    effectiveGmv: 0,
    refundedAmount: 0,
    validOrders: 0,
    confirmedCost: 0,
    estimatedCost: 0,
    uncostedOrders: 0,
    quantity: 0,
    unreconciledRefundOrders: 0,
    unreconciledGrossAmount: 0,
    costRelevantOrders: 0,
  };
}

function addTerminalPurchaseCost(bucket: AggregateBucket, order: AnalyticsOrder): void {
  if (order.purchaseOrders.length === 0) return;
  bucket.costRelevantOrders++;
  addStoredPurchaseCost(bucket, order);
}

function addStoredPurchaseCost(bucket: AggregateBucket, order: AnalyticsOrder): void {
  const costs = order.purchaseOrders.map(accountedPurchaseCost);
  let total = 0;
  for (const cost of costs) {
    if (cost === null) {
      bucket.uncostedOrders++;
      return;
    }
    total += cost;
  }
  bucket.confirmedCost += total;
}

function accountedPurchaseCost(purchase: AnalyticsOrder['purchaseOrders'][number]): number | null {
  const priorCost = Number(purchase.priorIncurredCost);
  if (!Number.isFinite(priorCost) || priorCost < 0) return null;
  if (
    purchase.exceptionStatus === 'stopped' &&
    purchase.orderId1688 === null &&
    ['pending', 'failed'].includes(purchase.status)
  ) {
    return priorCost;
  }
  if (purchase.exceptionStatus === 'action_required') return null;
  if (purchase.exceptionStatus === 'resolved') {
    return purchase.reconciledCost === null ? null : Number(purchase.reconciledCost);
  }
  return purchase.purchaseCost === null ? null : priorCost + Number(purchase.purchaseCost);
}

function costSummary(bucket: AggregateBucket): AnalyticsCostSummary {
  return {
    total: bucket.uncostedOrders > 0 ? null : money(bucket.confirmedCost + bucket.estimatedCost),
    confirmed: money(bucket.confirmedCost),
    estimated: money(bucket.estimatedCost),
    uncostedOrders: bucket.uncostedOrders,
    coverageRate: coverageRate(bucket),
  };
}

function coverageRate(bucket: AggregateBucket): number {
  if (!bucket.costRelevantOrders) return 1;
  return ratio((bucket.costRelevantOrders - bucket.uncostedOrders) / bucket.costRelevantOrders);
}

function profit(bucket: AggregateBucket): number | null {
  if (bucket.uncostedOrders > 0) return null;
  return money(bucket.effectiveGmv - bucket.confirmedCost - bucket.estimatedCost);
}

function chinaDateRange(days: AnalyticsRangeDays, now: Date): { startAt: Date; endAt: Date } {
  const local = new Date(now.getTime() + CHINA_OFFSET_MS);
  const localStartUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - (days - 1),
  );
  return { startAt: new Date(localStartUtc - CHINA_OFFSET_MS), endAt: now };
}

function chinaDateKeys(days: AnalyticsRangeDays, endAt: Date): string[] {
  const localEnd = new Date(endAt.getTime() + CHINA_OFFSET_MS);
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(
      Date.UTC(localEnd.getUTCFullYear(), localEnd.getUTCMonth(), localEnd.getUTCDate() - offset),
    );
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

function chinaDateKey(value: Date): string {
  return new Date(value.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

function elapsedDays(startAt: Date, endAt: Date): number {
  return Math.max(1, Math.floor((endAt.getTime() - startAt.getTime()) / DAY_MS) + 1);
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function ratio(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
