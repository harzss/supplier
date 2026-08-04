'use client';

import { Suspense, useCallback, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RecommendationList } from '@/lib/api';
import { ProductCard } from '@/components/product-card';
import { ProductFilters, type AppliedProductFilters } from '@/components/product-filters';

export default function HomePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RecommendationPage />
    </Suspense>
  );
}

function RecommendationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const [isFilterPending, startFilterTransition] = useTransition();
  const queryClient = useQueryClient();
  const filters = readFilters(searchParams);
  const rangeError =
    filters.priceMin !== undefined &&
    filters.priceMax !== undefined &&
    filters.priceMin > filters.priceMax
      ? '最低价不能高于最高价，请重新设置价格范围。'
      : undefined;

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<RecommendationList>({
    queryKey: [
      'recommendations',
      filters.categoryL1 ?? '',
      filters.priceMin ?? null,
      filters.priceMax ?? null,
    ],
    queryFn: () =>
      api.recommendations({
        limit: 30,
        ...filters,
      }),
    enabled: !rangeError,
  });
  const facets = useQuery({ queryKey: ['product-facets'], queryFn: () => api.productFacets() });
  const favorites = useQuery({ queryKey: ['favorites'], queryFn: () => api.favorites() });
  const favoriteMutation = useMutation({
    mutationFn: async ({ productId1688, active }: { productId1688: string; active: boolean }) => {
      if (active) await api.removeFavorite(productId1688);
      else await api.addFavorite(productId1688);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favorites'] }),
  });
  const favoriteIds = new Set(favorites.data?.items.map((item) => item.productId1688) ?? []);
  const updateFilters = useCallback(
    (next: AppliedProductFilters) => {
      const params = new URLSearchParams(search);
      setFilterParam(params, 'categoryL1', next.categoryL1);
      setFilterParam(params, 'priceMin', next.priceMin);
      setFilterParam(params, 'priceMax', next.priceMax);
      const query = params.toString();
      startFilterTransition(() => router.replace(query ? `/?${query}` : '/', { scroll: false }));
    },
    [router, search],
  );

  return (
    <main className="app-page">
      <section className="home-intelligence mb-6">
        <header className="home-intelligence-header flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="page-title">今日选品</h1>
            <p className="page-description">
              综合采购价、销量趋势、利润与合规表现，快速找到更值得上架的商品。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/sources/import" className="primary-button source-entry-button shrink-0">
              批量采集 1688
            </Link>
            <Link
              href="/favorites"
              className="secondary-button home-favorite-action shrink-0 gap-2"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M6 4.5A2.5 2.5 0 0 1 8.5 2h7A2.5 2.5 0 0 1 18 4.5V22l-6-4-6 4V4.5Z" />
              </svg>
              收藏对比
              <span className="home-favorite-count rounded-full px-2 py-0.5 text-[11px] tabular-nums">
                {favorites.data?.total ?? 0}
              </span>
            </Link>
          </div>
        </header>

        <dl className="home-metric-grid mt-8 grid grid-cols-1 sm:grid-cols-3">
          <BriefMetric label="候选货源" value={data ? String(data.total) : '—'} unit="款" />
          <BriefMetric
            label="最高评分"
            value={data?.items[0]?.score?.overall?.toFixed(1) ?? '—'}
            unit="分"
          />
          <BriefMetric
            label="采购区间"
            value={
              facets.data?.priceRange
                ? `¥${formatCompactPrice(facets.data.priceRange.min)}–${formatCompactPrice(facets.data.priceRange.max)}`
                : '—'
            }
          />
        </dl>
      </section>

      <ProductFilters
        facets={facets.data}
        filters={filters}
        isLoading={facets.isLoading}
        isPending={isFilterPending || isFetching}
        rangeError={rangeError}
        onChange={updateFilters}
      />

      {isLoading && !rangeError ? <SkeletonGrid /> : null}

      {rangeError ? <div className="status-message is-danger mb-6">{rangeError}</div> : null}

      {isError ? (
        <div className="status-message is-danger mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>货源读取失败：{(error as Error).message}</span>
          <button
            type="button"
            onClick={() => void refetch()}
            className="secondary-button shrink-0"
          >
            重新读取
          </button>
        </div>
      ) : null}

      {data?.degraded && data.items.length === 0 ? (
        <div className="mb-6 border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          选品数据暂时无法从数据库完整读取，请稍后重试；当前空结果不代表没有可推荐商品。
        </div>
      ) : null}

      {data && !data.degraded && data.items.length === 0 ? (
        <div className="ledger-panel p-12 text-center text-[var(--muted)]">
          当前筛选条件下暂无已打分商品，试试放宽类目或价格范围。
        </div>
      ) : null}

      {data && data.items.length > 0 ? (
        <>
          <div className="mb-4 flex items-center justify-between gap-4 text-xs text-[var(--muted)]">
            <p>
              展示 {data.total} 款{data.degraded ? '（数据库降级中，结果可能不完整）' : ''}
            </p>
            {isFetching ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--accent-dark)]">
                <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                正在更新
              </span>
            ) : null}
          </div>
          <div className="product-grid">
            {data.items.map((p, i) => (
              <ProductCard
                key={p.id}
                product={p}
                rank={i + 1}
                isFavorite={favoriteIds.has(p.productId1688)}
                favoritePending={
                  favoriteMutation.isPending &&
                  favoriteMutation.variables?.productId1688 === p.productId1688
                }
                onToggleFavorite={() =>
                  favoriteMutation.mutate({
                    productId1688: p.productId1688,
                    active: favoriteIds.has(p.productId1688),
                  })
                }
              />
            ))}
          </div>
        </>
      ) : null}
    </main>
  );
}

function PageSkeleton() {
  return (
    <main className="app-page">
      <div className="skeleton-surface mb-6 h-28 rounded-2xl" />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="skeleton-surface h-24 rounded-xl" />
        ))}
      </div>
      <div className="skeleton-surface mb-6 h-32 rounded-xl" />
      <SkeletonGrid />
    </main>
  );
}

function SkeletonGrid() {
  return (
    <div className="product-grid">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-[var(--line)] bg-white">
          <div className="skeleton-surface aspect-square" />
          <div className="space-y-2 p-3">
            <div className="skeleton-surface h-3 rounded" />
            <div className="skeleton-surface h-3 w-2/3 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BriefMetric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="home-metric min-w-0 px-4 py-4">
      <dt className="home-metric-label text-xs font-medium">{label}</dt>
      <dd className="home-metric-value mt-1.5 truncate text-xl font-semibold tracking-tight tabular-nums">
        {value}
        {unit ? <span className="home-metric-unit ml-1 text-xs font-medium">{unit}</span> : null}
      </dd>
    </div>
  );
}

function formatCompactPrice(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

function readFilters(searchParams: ReturnType<typeof useSearchParams>): AppliedProductFilters {
  const categoryL1 = searchParams.get('categoryL1')?.trim() || undefined;
  return {
    categoryL1,
    priceMin: readPrice(searchParams.get('priceMin')),
    priceMax: readPrice(searchParams.get('priceMax')),
  };
}

function readPrice(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function setFilterParam(
  params: URLSearchParams,
  name: string,
  value: string | number | undefined,
): void {
  if (value === undefined || value === '') params.delete(name);
  else params.set(name, String(value));
}
