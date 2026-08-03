'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AnalyticsDailyPoint,
  AnalyticsOverview,
  AnalyticsProductPerformanceItem,
  AnalyticsRangeDays,
} from '@supplier/shared-types';
import Link from 'next/link';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';

const RANGE_OPTIONS: AnalyticsRangeDays[] = [7, 30, 90];
const STATUS_LABELS: Record<string, string> = {
  paid: '待代发',
  purchasing: '采购中',
  shipped: '已发货',
  received: '已收货',
  refunded: '已退款',
  closed: '已关闭',
};
const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音小店',
  taobao: '淘宝',
  tmall: '天猫',
  pdd: '拼多多',
  kuaishou: '快手小店',
  wechat_shop: '视频号小店',
};

export default function AnalyticsPage() {
  const [days, setDays] = useState<AnalyticsRangeDays>(30);
  const overview = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api.analyticsOverview(days),
  });

  return (
    <main className="app-page">
      <div>
        <header className="mb-6 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="page-kicker">数据中心</p>
            <h1 className="page-title">经营分析</h1>
            <p className="page-description">
              用订单和采购记录说话。GMV、成本、预计毛利与商品动销均来自当前账户数据，并保留计算口径。
            </p>
          </div>
          <div className="flex w-fit rounded-xl bg-[var(--surface-strong)] p-1">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option}
                onClick={() => setDays(option)}
                className={`min-h-10 rounded-lg px-4 py-2 text-xs font-semibold transition ${
                  days === option
                    ? 'bg-white text-brand-700 shadow-sm ring-1 ring-black/5'
                    : 'text-[var(--muted)] hover:bg-white/60'
                }`}
              >
                {option} 天
              </button>
            ))}
          </div>
        </header>

        {overview.isLoading ? <DashboardSkeleton /> : null}
        {overview.isError ? <DashboardError error={overview.error} /> : null}
        {overview.data ? <Dashboard data={overview.data} /> : null}
      </div>
    </main>
  );
}

function Dashboard({ data }: { data: AnalyticsOverview }) {
  const kpis = data.kpis;
  const profitTone = kpis.estimatedGrossProfit !== null && kpis.estimatedGrossProfit < 0;
  return (
    <div className="space-y-6">
      {kpis.unreconciledRefundOrders > 0 ? (
        <section className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="leading-6 text-amber-800">
            有 {kpis.unreconciledRefundOrders} 笔退款订单尚未核对实际退款金额，涉及原订单金额{' '}
            {formatMoney(kpis.unreconciledGrossAmount)}；当前 GMV、毛利和排行已安全排除这些订单。
          </p>
          <Link href="/orders" className="secondary-button shrink-0">
            去订单核对
          </Link>
        </section>
      ) : null}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          index="01"
          label="有效 GMV"
          value={formatMoney(kpis.effectiveGmv)}
          note={`${kpis.validOrders} 笔已计入订单`}
        />
        <KpiCard
          index="02"
          label="预计毛利"
          value={
            kpis.estimatedGrossProfit === null
              ? '成本待补齐'
              : formatMoney(kpis.estimatedGrossProfit)
          }
          note={
            kpis.estimatedGrossMargin === null
              ? `${kpis.cost.uncostedOrders} 笔订单无成本依据`
              : `预计毛利率 ${formatPercent(kpis.estimatedGrossMargin)}`
          }
          danger={profitTone}
        />
        <KpiCard
          index="03"
          label="净客单价"
          value={formatMoney(kpis.averageOrderValue)}
          note={`退款额 ${formatMoney(kpis.refundedAmount)}`}
        />
        <KpiCard
          index="04"
          label="成本覆盖率"
          value={formatPercent(kpis.cost.coverageRate)}
          note={`已确认 ${formatMoney(kpis.cost.confirmed)} · 估算 ${formatMoney(kpis.cost.estimated)}`}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.75fr)]">
        <LedgerPanel title="每日经营曲线">
          <TrendChart points={data.daily} />
        </LedgerPanel>
        <LedgerPanel title="订单状态">
          <div className="space-y-1">
            {data.statuses.map((item) => {
              const total = Math.max(1, ...data.statuses.map((status) => status.count));
              return (
                <div
                  key={item.status}
                  className="group grid grid-cols-[76px_1fr_36px] items-center gap-3 py-2"
                >
                  <span className="text-xs text-[var(--muted)]">{STATUS_LABELS[item.status]}</span>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--paper-deep)]">
                    <div
                      className={`h-full origin-left rounded-full transition-transform ${
                        item.status === 'refunded' ? 'bg-red-500' : 'bg-brand-500'
                      }`}
                      style={{ transform: `scaleX(${item.count / total})` }}
                    />
                  </div>
                  <span className="text-right text-xs font-semibold tabular-nums">
                    {item.count}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-5 border-t border-[var(--line)] pt-4 text-xs leading-5 text-[var(--muted)]">
            统计区间：{formatDate(data.range.startAt)} — {formatDate(data.range.endAt)}
            ，按中国标准时间归档。
          </p>
        </LedgerPanel>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
        <LedgerPanel title="店铺表现">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[650px] border-collapse text-left text-sm">
              <thead className="text-xs text-[var(--muted)]">
                <tr className="border-b border-[var(--line)]">
                  <th className="pb-3 font-medium">店铺</th>
                  <th className="pb-3 text-right font-medium">有效 GMV</th>
                  <th className="pb-3 text-right font-medium">订单</th>
                  <th className="pb-3 text-right font-medium">预计毛利</th>
                  <th className="pb-3 text-right font-medium">成本覆盖</th>
                </tr>
              </thead>
              <tbody>
                {data.shops.map((shop) => (
                  <tr key={shop.shopId} className="border-b border-[var(--line)] last:border-0">
                    <td className="py-4">
                      <p className="font-medium">{shop.shopName}</p>
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {PLATFORM_LABELS[shop.platform] ?? shop.platform}
                      </p>
                    </td>
                    <td className="py-4 text-right font-mono font-semibold">
                      {formatMoney(shop.effectiveGmv)}
                    </td>
                    <td className="py-4 text-right font-mono">{shop.validOrders}</td>
                    <td className="py-4 text-right font-mono">
                      {shop.estimatedGrossProfit === null
                        ? '—'
                        : formatMoney(shop.estimatedGrossProfit)}
                    </td>
                    <td className="py-4 text-right font-mono">
                      {formatPercent(shop.costCoverageRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </LedgerPanel>

        <LedgerPanel title="商品贡献">
          {data.products.length ? (
            <div className="space-y-5">
              {data.products.map((product, index) => {
                const max = data.products[0]?.effectiveGmv || 1;
                return (
                  <div key={product.publishedProductId ?? `unlinked-${index}`}>
                    <div className="mb-2 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-sm font-medium leading-5">
                          {product.title}
                        </p>
                        <p className="mt-1 text-[10px] text-[var(--muted)]">
                          {product.validOrders} 单 · {product.quantity} 件
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-sm font-semibold">
                        {formatMoney(product.effectiveGmv)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--paper-deep)]">
                      <div
                        className="h-full origin-left rounded-full bg-brand-500 transition-transform"
                        style={{ transform: `scaleX(${product.effectiveGmv / max})` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState />
          )}
        </LedgerPanel>
      </section>

      <ProductPerformance data={data.productPerformance} />

      <section className="ledger-panel grid gap-6 p-5 md:grid-cols-[160px_1fr] md:p-6">
        <div>
          <p className="page-kicker">说明</p>
          <h2 className="mt-2 text-xl font-semibold">数据口径</h2>
        </div>
        <div className="grid gap-4 text-sm leading-6 text-[var(--muted)] lg:grid-cols-3">
          <p>
            <strong className="text-[var(--ink)]">GMV：</strong>
            {data.methodology.gmv}
          </p>
          <p>
            <strong className="text-[var(--ink)]">成本：</strong>
            {data.methodology.cost}
          </p>
          <p>
            <strong className="text-[var(--ink)]">毛利：</strong>
            {data.methodology.profit}
            <span className="mt-1 block text-xs text-[var(--muted)]">
              暂不计：{data.methodology.exclusions.join('、')}。
            </span>
          </p>
        </div>
      </section>
    </div>
  );
}

function ProductPerformance({ data }: { data: AnalyticsOverview['productPerformance'] }) {
  const summary = data.summary;
  const hotMaxRate = data.hot[0]?.dailyOrderRate || 1;
  return (
    <LedgerPanel title="动销雷达">
      <div className="mb-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PulseMetric label="在线商品" value={String(summary.onlineProducts)} note="当前在线铺货" />
        <PulseMetric
          label="区间有成交"
          value={String(summary.sellingProducts)}
          note={`动销率 ${formatPercent(summary.activityRate)}`}
        />
        <PulseMetric
          label="成熟商品"
          value={String(summary.eligibleProducts)}
          note={`已上架至少 ${summary.graceDays} 天`}
        />
        <PulseMetric
          label="滞销风险"
          value={String(summary.slowProducts)}
          note="成熟且区间零成交"
          danger={summary.slowProducts > 0}
        />
      </div>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-0">
        <div className="lg:border-r lg:border-[var(--line)] lg:pr-7">
          <div className="mb-5 flex items-baseline justify-between gap-3">
            <h3 className="text-lg font-semibold">热销加速榜</h3>
            <span className="text-[10px] text-[var(--muted)]">按日均有效订单</span>
          </div>
          {data.hot.length ? (
            <div className="space-y-5">
              {data.hot.slice(0, 5).map((product, index) => (
                <div key={product.publishedProductId}>
                  <div className="mb-2 grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3">
                    <span className="text-xs font-semibold text-brand-600 tabular-nums">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <ProductIdentity product={product} />
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums">
                        {formatOrderRate(product.dailyOrderRate)}
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--muted)] tabular-nums">
                        {formatMoney(product.effectiveGmv)}
                      </p>
                    </div>
                  </div>
                  <div className="ml-10 h-1 overflow-hidden rounded-full bg-[var(--paper-deep)]">
                    <div
                      className="h-full rounded-full bg-brand-500"
                      style={{ width: `${(product.dailyOrderRate / hotMaxRate) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ProductPerformanceEmpty>当前区间还没有产生有效成交。</ProductPerformanceEmpty>
          )}
        </div>

        <div className="border-t border-[var(--line)] pt-7 lg:border-0 lg:pl-7 lg:pt-0">
          <div className="mb-5 flex items-baseline justify-between gap-3">
            <h3 className="text-lg font-semibold">滞销风险榜</h3>
            <span className="text-[10px] text-[var(--muted)]">{summary.graceDays} 天观察期</span>
          </div>
          {data.slow.length ? (
            <div className="divide-y divide-[var(--line)]">
              {data.slow.slice(0, 5).map((product, index) => (
                <div
                  key={product.publishedProductId}
                  className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 py-4 first:pt-0"
                >
                  <span className="text-xs font-semibold text-brand-600 tabular-nums">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <ProductIdentity product={product} />
                  <div className="text-right text-[10px] text-[var(--muted)] tabular-nums">
                    <p className="font-semibold text-[var(--ink)]">上架 {product.daysOnline} 天</p>
                    <p className="mt-1">
                      {product.daysSinceLastSale === null
                        ? '尚无成交'
                        : `${product.daysSinceLastSale} 天未成交`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ProductPerformanceEmpty>
              当前没有“上架满 {summary.graceDays} 天且区间零成交”的商品。
            </ProductPerformanceEmpty>
          )}
        </div>
      </div>

      <p className="mt-7 border-t border-[var(--line)] pt-4 text-xs leading-5 text-[var(--muted)]">
        {data.methodology}
      </p>
    </LedgerPanel>
  );
}

function PulseMetric({
  label,
  value,
  note,
  danger = false,
}: {
  label: string;
  value: string;
  note: string;
  danger?: boolean;
}) {
  return (
    <div className="ledger-panel px-4 py-5">
      <p className="text-xs font-medium text-[var(--muted)]">{label}</p>
      <p
        className={`mt-2 text-3xl font-semibold tracking-tight tabular-nums ${danger ? 'text-red-600' : ''}`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs text-[var(--muted)]">{note}</p>
    </div>
  );
}

function ProductIdentity({ product }: { product: AnalyticsProductPerformanceItem }) {
  return (
    <div className="min-w-0">
      <p className="line-clamp-2 text-sm font-medium leading-5">{product.title}</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">
        {product.shopName} · {PLATFORM_LABELS[product.platform] ?? product.platform} ·{' '}
        {product.validOrders} 单 / {product.quantity} 件
      </p>
    </div>
  );
}

function ProductPerformanceEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-4 py-10 text-center text-sm text-[var(--muted)]">
      {children}
    </div>
  );
}

function TrendChart({ points }: { points: AnalyticsDailyPoint[] }) {
  const width = 760;
  const height = 250;
  const left = 42;
  const right = 16;
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(
    1,
    ...points.flatMap((point) => [point.effectiveGmv, point.refundedAmount]),
  );
  const x = (index: number) => left + (index / Math.max(1, points.length - 1)) * plotWidth;
  const y = (value: number) => top + plotHeight - (value / maxValue) * plotHeight;
  const gmvPoints = points.map((point, index) => `${x(index)},${y(point.effectiveGmv)}`).join(' ');
  const refundPoints = points
    .map((point, index) => `${x(index)},${y(point.refundedAmount)}`)
    .join(' ');
  const areaPath = points.length
    ? `M ${x(0)} ${top + plotHeight} L ${points
        .map((point, index) => `${x(index)} ${y(point.effectiveGmv)}`)
        .join(' L ')} L ${x(points.length - 1)} ${top + plotHeight} Z`
    : '';
  const labels = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (index, position, values) => index >= 0 && values.indexOf(index) === position,
  );

  return (
    <div>
      <div className="mb-4 flex gap-5 text-[10px] font-medium text-[var(--muted)]">
        <span className="flex items-center gap-2">
          <i className="h-0.5 w-5 bg-brand-500" />
          有效 GMV
        </span>
        <span className="flex items-center gap-2">
          <i className="h-0.5 w-5 bg-red-500" />
          退款额
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="每日 GMV 与退款趋势"
      >
        {[0, 0.5, 1].map((fraction) => {
          const lineY = top + plotHeight * fraction;
          return (
            <g key={fraction}>
              <line
                x1={left}
                x2={width - right}
                y1={lineY}
                y2={lineY}
                stroke="#e5e7eb"
                strokeDasharray="3 5"
              />
              <text x={left - 8} y={lineY + 4} textAnchor="end" fontSize="10" fill="#687180">
                {formatCompactMoney(maxValue * (1 - fraction))}
              </text>
            </g>
          );
        })}
        <path d={areaPath} fill="#5b5bd6" opacity="0.08" />
        <polyline
          points={gmvPoints}
          fill="none"
          stroke="#5b5bd6"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <polyline
          points={refundPoints}
          fill="none"
          stroke="#d14343"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {labels.map((index) => (
          <text
            key={index}
            x={x(index)}
            y={height - 8}
            textAnchor="middle"
            fontSize="10"
            fill="#687180"
          >
            {points[index]?.date.slice(5)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function KpiCard({
  index,
  label,
  value,
  note,
  danger = false,
}: {
  index: string;
  label: string;
  value: string;
  note: string;
  danger?: boolean;
}) {
  return (
    <article className="ledger-panel min-h-36 p-5">
      <div className="flex items-center justify-between text-xs font-medium text-[var(--muted)]">
        <span>{label}</span>
        <span>{index}</span>
      </div>
      <p
        className={`mt-5 text-3xl font-semibold tracking-tight tabular-nums ${danger ? 'text-red-600' : ''}`}
      >
        {value}
      </p>
      <p className="mt-3 text-xs text-[var(--muted)]">{note}</p>
    </article>
  );
}

function LedgerPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ledger-panel min-w-0 p-5 sm:p-6">
      <div className="mb-6 border-b border-[var(--line)] pb-4">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="skeleton-surface h-36 rounded-xl" />
      ))}
    </div>
  );
}

function DashboardError({ error }: { error: Error }) {
  const locked = error instanceof ApiError && error.code === 'FEATURE_LOCKED';
  return (
    <div className="ledger-panel p-8 text-center">
      <p className="text-xl font-semibold">
        {locked ? '当前内测权限未开放经营分析' : '经营数据暂时不可用'}
      </p>
      <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-[var(--muted)]">{error.message}</p>
      {locked ? (
        <a href="/settings#capacity-options" className="secondary-button mt-5">
          申请内测扩容 →
        </a>
      ) : null}
    </div>
  );
}

function EmptyState() {
  return <p className="py-10 text-center text-sm text-[var(--muted)]">当前区间还没有有效订单。</p>;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(value);
}

function formatCompactMoney(value: number): string {
  if (value >= 10_000) return `¥${(value / 10_000).toFixed(1)}万`;
  return `¥${Math.round(value)}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value === 1 || value === 0 ? 0 : 1)}%`;
}

function formatOrderRate(value: number): string {
  return `${value.toFixed(2)} 单/天`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
