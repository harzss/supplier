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
      <header className="mb-8 grid gap-7 border-b border-[var(--ink)] pb-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)] lg:items-end">
        <div>
          <p className="page-kicker">Sourcing desk / Daily brief 01</p>
          <h1 className="page-title max-w-3xl">今天，搬更有胜算的款</h1>
          <p className="page-description">
            把采购价、月销、趋势、利润与合规放在同一张选品桌上。先看判断，再看商品。
          </p>
        </div>
        <div className="ledger-panel overflow-hidden">
          <div className="grid grid-cols-3 divide-x divide-[var(--line)]">
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
          </div>
          <Link
            href="/favorites"
            className="flex min-h-12 items-center justify-between border-t border-[var(--line)] px-4 text-xs font-bold text-[var(--ink)] transition hover:bg-[var(--accent-soft)]"
          >
            <span>进入收藏对比</span>
            <span className="font-mono text-[var(--accent-dark)]">
              {favorites.data ? `${favorites.data.total} SAVED` : 'OPEN'} →
            </span>
          </Link>
        </div>
      </header>

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
          <div className="mb-4 flex items-center justify-between gap-4 border-b border-[var(--line)] pb-3 text-xs text-[var(--muted)]">
            <p className="font-mono uppercase tracking-[0.12em]">
              展示 {data.total} 款{data.degraded ? '（数据库降级中，结果可能不完整）' : ''}
            </p>
            {isFetching ? (
              <span className="font-mono text-[10px] uppercase text-[var(--accent-dark)]">
                Updating…
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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
      <div className="mb-8 h-48 animate-pulse border-b border-[var(--line)] bg-white/20" />
      <div className="mb-8 h-52 animate-pulse border border-[var(--line)] bg-[var(--surface)]" />
      <SkeletonGrid />
    </main>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface)]"
        >
          <div className="aspect-[4/5] animate-pulse bg-[var(--paper-deep)]" />
          <div className="space-y-2 p-3">
            <div className="h-3 animate-pulse bg-[var(--paper-deep)]" />
            <div className="h-3 w-2/3 animate-pulse bg-[var(--paper-deep)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BriefMetric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0 px-3 py-4 sm:px-4">
      <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">
        {label}
      </p>
      <p className="mt-2 truncate font-mono text-lg font-bold tracking-tight text-[var(--ink)] sm:text-xl">
        {value}
        {unit ? (
          <span className="ml-1 text-[10px] font-medium text-[var(--muted)]">{unit}</span>
        ) : null}
      </p>
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
